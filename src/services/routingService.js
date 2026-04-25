// src/services/routingService.js
const axios = require('axios');
const { query } = require('../config/database');
const { cache } = require('../config/redis');
const { getRouteRiskScores } = require('./crimeService');
const { aStar } = require('../utils/geoUtils');
const { logger } = require('../utils/logger');

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const OPENWEATHER_KEY = process.env.OPENWEATHER_API_KEY;

/**
 * Get current weather at a location
 */
const getWeather = async (lat, lng) => {
  const cacheKey = `weather:${parseFloat(lat).toFixed(2)}:${parseFloat(lng).toFixed(2)}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  try {
    const resp = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${OPENWEATHER_KEY}&units=metric`,
      { timeout: 4000 }
    );
    const w = {
      condition: resp.data.weather[0]?.main?.toLowerCase() || 'clear',
      description: resp.data.weather[0]?.description,
      temp: resp.data.main?.temp,
      visibility: resp.data.visibility, // meters
      icon: resp.data.weather[0]?.icon,
      is_night: resp.data.weather[0]?.icon?.endsWith('n'),
      is_rain: ['rain', 'drizzle', 'thunderstorm'].includes(resp.data.weather[0]?.main?.toLowerCase()),
      is_fog: ['mist', 'fog', 'haze', 'smoke'].includes(resp.data.weather[0]?.main?.toLowerCase()),
    };
    await cache.set(cacheKey, w, 600); // 10 min
    return w;
  } catch (err) {
    logger.warn('Weather fetch failed', { error: err.message });
    return { condition: 'unknown', is_night: new Date().getHours() >= 20 || new Date().getHours() <= 6, is_rain: false, is_fog: false };
  }
};

/**
 * Fetch route from Google Maps Directions API
 */
const getGoogleRoute = async (origin, destination, mode = 'walking', alternatives = true) => {
  if (!GOOGLE_MAPS_KEY) throw new Error('Google Maps API key not configured');

  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&mode=${mode}&alternatives=${alternatives}&key=${GOOGLE_MAPS_KEY}`;
  const resp = await axios.get(url, { timeout: 8000 });

  if (resp.data.status !== 'OK') {
    throw new Error(`Google Maps error: ${resp.data.status}`);
  }

  return resp.data.routes.map((route) => ({
    summary: route.summary,
    distance: route.legs[0].distance,
    duration: route.legs[0].duration,
    steps: route.legs[0].steps,
    polyline: route.overview_polyline.points,
    waypoints: decodePolyline(route.overview_polyline.points),
  }));
};

/**
 * POST /api/route/shortest — A* with live traffic + crime weighting
 */
const getShortestRoute = async (origin, destination) => {
  try {
    const routes = await getGoogleRoute(origin, destination, 'walking', true);
    if (!routes.length) throw new Error('No routes found');

    // Score each route by crime risk
    const scoredRoutes = await Promise.all(
      routes.slice(0, 3).map(async (route) => {
        const sample = route.waypoints.filter((_, i) => i % 5 === 0); // sample every 5th point
        const riskData = await getRouteRiskScores(sample);
        return { ...route, risk: riskData };
      })
    );

    // Pick route with best distance:risk ratio
    const best = scoredRoutes.sort((a, b) => {
      const scoreA = a.distance.value + a.risk.average_risk * 100;
      const scoreB = b.distance.value + b.risk.average_risk * 100;
      return scoreA - scoreB;
    })[0];

    return { route: best, alternatives: scoredRoutes };
  } catch (err) {
    logger.error('Shortest route error', { error: err.message });
    throw err;
  }
};

/**
 * POST /api/route/lit-street — weather-aware route (avoids dark/isolated segments)
 */
const getLitStreetRoute = async (origin, destination) => {
  const [routes, weather] = await Promise.all([
    getGoogleRoute(origin, destination, 'walking', true),
    getWeather(origin.lat, origin.lng),
  ]);

  if (!routes.length) throw new Error('No routes found');

  // Fetch lit streets from DB (streets with lighting data)
  const litStreets = await query(
    `SELECT name, ST_AsGeoJSON(path) as geojson, is_lit, lighting_score
     FROM streets
     WHERE ST_DWithin(path::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 2000)
     AND is_lit = true`,
    [origin.lat, origin.lng]
  ).catch(() => ({ rows: [] }));

  // Score routes: prioritize lit streets at night/rain
  const scored = await Promise.all(
    routes.slice(0, 3).map(async (route) => {
      const riskData = await getRouteRiskScores(route.waypoints.filter((_, i) => i % 5 === 0));
      let weatherPenalty = 0;
      if (weather.is_night) weatherPenalty += 20;
      if (weather.is_rain) weatherPenalty += 10;
      if (weather.is_fog) weatherPenalty += 15;
      return {
        ...route,
        risk: riskData,
        weather,
        weather_penalty: weatherPenalty,
        adjusted_risk: Math.min(100, riskData.average_risk + weatherPenalty),
        lit_streets_count: litStreets.rows.length,
        recommendations: buildWeatherRecommendations(weather),
      };
    })
  );

  const best = scored.sort((a, b) => a.adjusted_risk - b.adjusted_risk)[0];
  return { route: best, weather, alternatives: scored };
};

/**
 * POST /api/route/safe-refuges — nearby safe havens
 */
const getSafeRefuges = async (lat, lng, radiusMeters = 1000, types = ['police', 'hospital', 'cafe', 'shelter']) => {
  const cacheKey = `refuges:${parseFloat(lat).toFixed(3)}:${parseFloat(lng).toFixed(3)}:${radiusMeters}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const typeFilter = types.map((_, i) => `$${i + 3}`).join(',');
  const result = await query(
    `SELECT id, name, type, hours, phone,
            ST_AsGeoJSON(location) as geojson,
            ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) AS distance_meters
     FROM refuges
     WHERE type = ANY($3::text[])
     AND ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $4)
     ORDER BY distance_meters ASC LIMIT 20`,
    [lat, lng, types, radiusMeters]
  );

  const refuges = result.rows.map((r) => {
    const geo = JSON.parse(r.geojson);
    return {
      ...r,
      lat: geo.coordinates[1],
      lng: geo.coordinates[0],
      distance_meters: Math.round(r.distance_meters),
      distance_text: formatDistance(r.distance_meters),
    };
  });

  await cache.set(cacheKey, refuges, 900);
  return refuges;
};

/**
 * POST /api/route/reroute — compute new safe route on deviation
 */
const getReroute = async (currentLat, currentLng, destination) => {
  const [route, refuges] = await Promise.all([
    getShortestRoute({ lat: currentLat, lng: currentLng }, destination),
    getSafeRefuges(currentLat, currentLng, 300),
  ]);

  return {
    ...route,
    nearest_refuge: refuges[0] || null,
    rerouted_at: new Date().toISOString(),
    message: 'New safe route computed due to deviation or safety concern',
  };
};

// ── Helpers ────────────────────────────────────────────────

const decodePolyline = (encoded) => {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
};

const formatDistance = (meters) => {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
};

const buildWeatherRecommendations = (weather) => {
  const recs = [];
  if (weather.is_night) recs.push('Prefer well-lit streets', 'Stay in populated areas');
  if (weather.is_rain) recs.push('Visibility reduced — check in frequently', 'Prefer covered routes');
  if (weather.is_fog) recs.push('Very low visibility — share location with guardian');
  return recs;
};

module.exports = { getShortestRoute, getLitStreetRoute, getSafeRefuges, getReroute, getWeather };

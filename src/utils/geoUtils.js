// src/utils/geoUtils.js

/**
 * Haversine distance between two lat/lng points in meters
 */
const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371000; // Earth's radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

/**
 * Check if a point deviates from a LineString route by more than threshold meters
 * route: array of {lat, lng}
 */
const isDeviatedFromRoute = (userLat, userLng, route, thresholdMeters = 50) => {
  if (!route || route.length < 2) return false;
  
  let minDist = Infinity;
  for (const point of route) {
    const dist = haversineDistance(userLat, userLng, point.lat, point.lng);
    if (dist < minDist) minDist = dist;
  }
  
  return minDist > thresholdMeters;
};

/**
 * Calculate bounding box for a given center and radius (meters)
 */
const getBoundingBox = (lat, lng, radiusMeters) => {
  const latDelta = radiusMeters / 111320;
  const lngDelta = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
};

/**
 * Convert GeoJSON LineString coordinates to PostGIS LINESTRING WKT
 */
const coordsToLineString = (coords) => {
  const points = coords.map(([lng, lat]) => `${lng} ${lat}`).join(', ');
  return `LINESTRING(${points})`;
};

/**
 * Convert lat/lng to PostGIS POINT WKT
 */
const toPoint = (lat, lng) => `POINT(${lng} ${lat})`;

/**
 * Simple A* heuristic — Euclidean distance for grid graphs
 */
const euclideanHeuristic = (a, b) => {
  return Math.sqrt((a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2);
};

/**
 * A* pathfinding on a graph of nodes
 * nodes: [{id, lat, lng, riskScore}]
 * edges: [{from, to, weight}]
 */
const aStar = (nodes, edges, startId, endId) => {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map();

  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.from)?.push({ to: e.to, weight: e.weight });
    adj.get(e.to)?.push({ to: e.from, weight: e.weight });
  }

  const openSet = new Set([startId]);
  const cameFrom = new Map();
  const gScore = new Map(nodes.map((n) => [n.id, Infinity]));
  const fScore = new Map(nodes.map((n) => [n.id, Infinity]));

  gScore.set(startId, 0);
  fScore.set(startId, euclideanHeuristic(nodeMap.get(startId), nodeMap.get(endId)));

  while (openSet.size > 0) {
    let current = null;
    let lowestF = Infinity;
    for (const id of openSet) {
      if (fScore.get(id) < lowestF) {
        lowestF = fScore.get(id);
        current = id;
      }
    }

    if (current === endId) {
      const path = [];
      let c = endId;
      while (c !== undefined) {
        path.unshift(nodeMap.get(c));
        c = cameFrom.get(c);
      }
      return path;
    }

    openSet.delete(current);
    for (const neighbor of adj.get(current) || []) {
      const tentativeG = gScore.get(current) + neighbor.weight;
      if (tentativeG < gScore.get(neighbor.to)) {
        cameFrom.set(neighbor.to, current);
        gScore.set(neighbor.to, tentativeG);
        fScore.set(neighbor.to, tentativeG + euclideanHeuristic(nodeMap.get(neighbor.to), nodeMap.get(endId)));
        openSet.add(neighbor.to);
      }
    }
  }

  return []; // No path found
};

module.exports = { haversineDistance, isDeviatedFromRoute, getBoundingBox, coordsToLineString, toPoint, aStar };

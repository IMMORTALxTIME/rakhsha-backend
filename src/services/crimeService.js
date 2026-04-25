// src/services/crimeService.js
const axios = require('axios');
const { query } = require('../config/database');
const { cache } = require('../config/redis');
const { logger } = require('../utils/logger');

const CACHE_TTL = 300; // 5 min

/**
 * Get risk score from ML microservice, falling back to DB heuristics
 */
const getRiskScore = async (lat, lng) => {
  const cacheKey = `risk:${parseFloat(lat).toFixed(4)}:${parseFloat(lng).toFixed(4)}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  let result;

  // Try ML microservice first
  if (process.env.ML_SERVICE_URL) {
    try {
      const resp = await axios.post(`${process.env.ML_SERVICE_URL}/predict`, { lat, lng }, { timeout: 3000 });
      if (resp.data?.risk_score !== undefined) {
        result = {
          risk_score: Math.round(resp.data.risk_score),
          color_code: scoreToColor(resp.data.risk_score),
          source: 'ml_model',
          factors: resp.data.factors || [],
        };
      }
    } catch (err) {
      logger.warn('ML service unavailable, falling back to DB heuristics', { error: err.message });
    }
  }

  // Fallback: heuristic from DB crime history
  if (!result) {
    result = await computeHeuristicScore(lat, lng);
  }

  await cache.set(cacheKey, result, CACHE_TTL);
  return result;
};

const computeHeuristicScore = async (lat, lng) => {
  try {
    // Crimes within 500m, weighted by severity and recency
    const crimeRes = await query(
      `SELECT severity, crime_type, timestamp,
              ST_Distance(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) AS dist_meters
       FROM crime_history
       WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 500)
       ORDER BY timestamp DESC LIMIT 50`,
      [lat, lng]
    );

    // Report density in 200m
    const reportRes = await query(
      `SELECT COUNT(*) as count FROM reports
       WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 200)
       AND created_at > NOW() - INTERVAL '30 days'`,
      [lat, lng]
    );

    const crimes = crimeRes.rows;
    const reportCount = parseInt(reportRes.rows[0]?.count || 0);
    const hour = new Date().getHours();

    let score = 10; // Base score

    // Crime weighting
    for (const c of crimes) {
      const daysSince = (Date.now() - new Date(c.timestamp)) / (1000 * 60 * 60 * 24);
      const recencyWeight = Math.max(0, 1 - daysSince / 365);
      const distWeight = Math.max(0, 1 - c.dist_meters / 500);
      score += c.severity * recencyWeight * distWeight * 8;
    }

    // Recent user reports add to score
    score += reportCount * 5;

    // Night-time penalty (10pm - 5am)
    if (hour >= 22 || hour <= 5) score += 15;
    else if (hour >= 20 || hour <= 7) score += 8;

    const finalScore = Math.min(100, Math.round(score));
    const factors = buildFactors(crimes, reportCount, hour);

    return {
      risk_score: finalScore,
      color_code: scoreToColor(finalScore),
      source: 'heuristic',
      crimes_nearby: crimes.length,
      reports_nearby: reportCount,
      factors,
    };
  } catch (err) {
    logger.error('Heuristic score error', { error: err.message });
    return { risk_score: 30, color_code: 'yellow', source: 'default', factors: ['Unable to compute risk'] };
  }
};

const scoreToColor = (score) => {
  if (score <= 33) return 'green';
  if (score <= 66) return 'yellow';
  return 'red';
};

const buildFactors = (crimes, reportCount, hour) => {
  const factors = [];
  if (crimes.length > 5) factors.push(`${crimes.length} recorded incidents nearby`);
  if (reportCount > 2) factors.push(`${reportCount} community reports in last 30 days`);
  if (hour >= 22 || hour <= 5) factors.push('Late night hours (higher risk)');
  const types = [...new Set(crimes.map((c) => c.crime_type))].slice(0, 3);
  if (types.length) factors.push(`Crime types: ${types.join(', ')}`);
  return factors;
};

/**
 * Batch risk scoring for route waypoints
 */
const getRouteRiskScores = async (waypoints) => {
  const scores = await Promise.all(waypoints.map(({ lat, lng }) => getRiskScore(lat, lng)));
  const avg = scores.reduce((sum, s) => sum + s.risk_score, 0) / scores.length;
  return {
    waypoint_scores: scores,
    average_risk: Math.round(avg),
    overall_color: scoreToColor(avg),
    highest_risk: Math.max(...scores.map((s) => s.risk_score)),
  };
};

module.exports = { getRiskScore, getRouteRiskScores, scoreToColor };

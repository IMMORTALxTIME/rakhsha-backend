// src/config/swagger.js
const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Rakhsha Safety API',
      version: '1.0.0',
      description: 'Intelligent Safe-Route Navigation System for Women & Vulnerable Users',
      contact: { name: 'Rakhsha Team', email: 'api@rakhsha.app' },
      license: { name: 'MIT' },
    },
    servers: [
      { url: '/api/v1', description: 'Production' },
      { url: 'http://localhost:5000/api/v1', description: 'Local Dev' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'fail' },
            message: { type: 'string', example: 'Error message here' },
          },
        },
        Coordinates: {
          type: 'object',
          required: ['lat', 'lng'],
          properties: {
            lat: { type: 'number', format: 'float', example: 23.2599 },
            lng: { type: 'number', format: 'float', example: 77.4126 },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Priya Sharma' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string', example: '+919876543210' },
            role: { type: 'string', enum: ['user', 'admin', 'guardian'] },
          },
        },
        RouteRequest: {
          type: 'object',
          required: ['origin', 'destination'],
          properties: {
            origin: { $ref: '#/components/schemas/Coordinates' },
            destination: { $ref: '#/components/schemas/Coordinates' },
          },
        },
        RiskScore: {
          type: 'object',
          properties: {
            risk_score: { type: 'integer', minimum: 0, maximum: 100, example: 42 },
            color_code: { type: 'string', enum: ['green', 'yellow', 'red'], example: 'yellow' },
            source: { type: 'string', example: 'ml_model' },
            factors: { type: 'array', items: { type: 'string' } },
          },
        },
        Report: {
          type: 'object',
          required: ['lat', 'lng', 'type'],
          properties: {
            lat: { type: 'number', example: 23.2599 },
            lng: { type: 'number', example: 77.4126 },
            type: { type: 'string', enum: ['harassment', 'theft', 'assault', 'suspicious_activity', 'unsafe_area', 'other'] },
            description: { type: 'string', maxLength: 1000 },
            severity: { type: 'integer', minimum: 1, maximum: 5, example: 3 },
          },
        },
        SOSTrigger: {
          type: 'object',
          required: ['lat', 'lng'],
          properties: {
            lat: { type: 'number', example: 23.2599 },
            lng: { type: 'number', example: 77.4126 },
            message: { type: 'string', example: 'I feel unsafe near the market.' },
          },
        },
        EmergencyContacts: {
          type: 'object',
          required: ['contacts'],
          properties: {
            contacts: {
              type: 'array',
              minItems: 1,
              maxItems: 5,
              items: {
                type: 'object',
                required: ['name', 'phone'],
                properties: {
                  name: { type: 'string', example: 'Mom' },
                  phone: { type: 'string', example: '+919876543210' },
                  email: { type: 'string', format: 'email' },
                  relation: { type: 'string', example: 'mother' },
                },
              },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth', description: 'Authentication & user management' },
      { name: 'Route', description: 'Safe route planning with A* algorithm' },
      { name: 'Crime', description: 'Crime prediction & risk scoring (ML)' },
      { name: 'Reports', description: 'Community incident reporting & heatmap' },
      { name: 'SOS', description: 'Emergency SOS & fake call' },
      { name: 'Guardian', description: 'Guardian relationships & live tracking' },
      { name: 'Safety', description: 'Check-in, health mode, smartwatch sync' },
    ],
  },
  apis: ['./src/routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);
module.exports = { swaggerSpec };

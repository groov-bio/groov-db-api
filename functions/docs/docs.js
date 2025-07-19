import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import * as yaml from 'js-yaml';

const allowedOrigins = [
  'http://localhost:3000',
  'https://groov.bio',
  'https://www.groov.bio'
];

// Function to get CORS headers based on the request origin
const getCorsHeaders = (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || 'http://localhost:3000';
  
  // Check if the origin is in our allowed list
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : 'http://localhost:3000';
  
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
};


export const handler = async (event) => {
  // Get CORS headers for this specific request
  const corsHeaders = getCorsHeaders(event);
  
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
    };
  }

  try {
    // Read the swagger.yaml file
    let swaggerYaml;
    
    // Try different possible locations for the swagger.yaml file
    try {
      // When packaged with the function directly
      const swaggerYamlPath = join(process.cwd(), 'swagger.yaml');
      swaggerYaml = readFileSync(swaggerYamlPath, 'utf8');
      console.log('Found swagger.yaml in the current working directory');
    } catch (error) {
      try {
        // For Lambda deployment path
        const swaggerYamlPath = join(__dirname, 'swagger.yaml');
        swaggerYaml = readFileSync(swaggerYamlPath, 'utf8');
        console.log('Found swagger.yaml in the __dirname directory');
      } catch (dirError) {
        console.error('Could not find swagger.yaml file in __dirname:', dirError);
        try {
          // Last attempt - parent directory
          const swaggerYamlPath = join(dirname(__dirname), 'docs', 'swagger.yaml');
          swaggerYaml = readFileSync(swaggerYamlPath, 'utf8');
          console.log('Found swagger.yaml in the parent directory structure');
        } catch (innerError) {
          console.error('Could not find swagger.yaml file anywhere:', innerError);
          throw new Error('Swagger YAML file not found');
        }
      }
    }
    
    // Parse the YAML file
    const swaggerJson = yaml.load(swaggerYaml);
    
    // Ensure the API definition has a valid OpenAPI version
    if (!swaggerJson.openapi && !swaggerJson.swagger) {
      swaggerJson.openapi = '3.0.0';
    }

    // Generate HTML with Swagger UI
    const html = generateSwaggerUI(JSON.stringify(swaggerJson));
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html',
        ...corsHeaders
      },
      body: html
    };
  } catch (error) {
    console.error('Error generating API documentation:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      },
      body: JSON.stringify({ message: 'Failed to generate API documentation', error: error.message })
    };
  }
};

function generateSwaggerUI(apiDefinition) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Groov API Documentation</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css">
  <style>
    body {
      margin: 0;
      padding: 0;
    }
    #swagger-ui {
      max-width: 1200px;
      margin: 0 auto;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      const ui = SwaggerUIBundle({
        spec: ${apiDefinition},
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout",
        displayRequestDuration: true,
        defaultModelRendering: 'model',
        defaultModelExpandDepth: 3,
        defaultModelsExpandDepth: 3,
        syntaxHighlight: {
          activate: true,
          theme: "agate"
        }
      });
    };
  </script>
</body>
</html>
  `;
}
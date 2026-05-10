import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import fetch from 'node-fetch';
import { logger } from './logger.js';

// Initialize the Lambda client for production use
const lambdaClient = new LambdaClient({
  region: "us-east-2"
});

export const invokeLambda = async (functionName, functionArn, payload, localEndpoint = null, method = 'POST') => {
  try {
    logger.info(`Invoking Lambda: ${functionName}`, { payload, method });

    logger.info(`IS_LOCAL: ${process.env.IS_LOCAL}`);
    
    if (process.env.IS_LOCAL === 'true' || process.env.IS_LOCAL === true) {
      // For local development, make a fetch request to Docker
      const endpoint = localEndpoint || functionName;
      let url = `http://host.docker.internal:3000/${endpoint}`;
      let options = {
        method: method,
        headers: {
          'Content-Type': 'application/json'
        }
      };
      
      // Handle different HTTP methods
      if (method === 'GET' && payload) {
        // Convert payload to query parameters for GET requests
        const params = new URLSearchParams();
        
        // Handle queryStringParameters if present
        if (payload.queryStringParameters) {
          Object.entries(payload.queryStringParameters).forEach(([key, value]) => {
            params.append(key, value);
          });
        } else {
          Object.entries(payload).forEach(([key, value]) => {
            params.append(key, value);
          });
        }
        
        url = `${url}?${params.toString()}`;
      } else if (method === 'POST') {
        options.body = JSON.stringify(payload);
      }
      
      logger.info(`Local development: fetching from ${url}`, { method });
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Local lambda fetch error`, { status: response.status, error: errorText });
        throw new Error(`Error invoking local lambda: ${response.status} - ${errorText}`);
      }
      
      const result = await response.json();
      logger.info(`Successfully invoked local Lambda: ${functionName}`);
      return result;
    } else {
      const command = new InvokeCommand({
        FunctionName: functionArn,
        Payload: Buffer.from(JSON.stringify(payload)),
      });

      const response = await lambdaClient.send(command);
      
      if (response.FunctionError) {
        logger.error(`Lambda invocation error`, { error: response.FunctionError, payload: response.Payload });
        throw new Error(`Error invoking lambda: ${response.FunctionError}`);
      }
      
      const rawPayload = new TextDecoder("utf-8").decode(response.Payload);
      
      let result;
      try {
        result = JSON.parse(rawPayload);
      } catch (err) {
        logger.error(`Error parsing Lambda response`, { rawPayload, error: err });
        throw new Error(`Error parsing Lambda response: ${err.message}`);
      }
      
      logger.info(`Successfully invoked Lambda: ${functionName}`);
      return result;
    }
  } catch (err) {
    logger.error(`Error invoking Lambda: ${functionName}`, err);
    throw err;
  }
};

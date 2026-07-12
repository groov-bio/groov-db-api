import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/getAllTempSensors/getAllTempSensors.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('GetAllTempSensors Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TEMP_TABLE_NAME = 'test-temp-table';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockTempSensorData = [
    {
      PK: 'TEMP',
      SK: 'P12345',
      family: 'GPCR',
      alias: 'TestSensor1',
      status: 'pending'
    },
    {
      PK: 'TEMP',
      SK: 'P67890',
      family: 'KINASE',
      alias: 'TestSensor2',
      status: 'pending'
    }
  ];

  // Enhanced mock data that includes the fields added by the function
  const enhancedMockTempSensorData = [
    {
      PK: 'TEMP',
      SK: 'P12345',
      family: 'GPCR',
      alias: 'TestSensor1',
      status: 'pending',
      uniProtID: 'P12345',
      submissionType: 'new',
      isEdit: false,
      originalSK: 'P12345'
    },
    {
      PK: 'TEMP',
      SK: 'P67890',
      family: 'KINASE',
      alias: 'TestSensor2',
      status: 'pending',
      uniProtID: 'P67890',
      submissionType: 'new',
      isEdit: false,
      originalSK: 'P67890'
    }
  ];

  describe('CORS handling', () => {
    test('should handle OPTIONS request', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'OPTIONS'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      expect(result.headers['Access-Control-Allow-Methods']).toBe('GET,OPTIONS');
    });

    test('should use allowed origin for groov.bio', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use allowed origin for www.groov.bio', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://www.groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
    });

    test('should use allowed origin for localhost', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'http://localhost:3000'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should use default origin for disallowed origins', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://malicious-site.com'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should use default origin when no origin header provided', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {}
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Successful data retrieval', () => {
    test('should successfully retrieve temp sensors', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      
      const body = JSON.parse(result.body);
      expect(body).toEqual(enhancedMockTempSensorData);
      
      const queryCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'QueryCommand');
      expect(queryCall.args[0].input.TableName).toBe('test-temp-table');
      expect(queryCall.args[0].input.KeyConditionExpression).toBe('PK = :PK');
      expect(queryCall.args[0].input.ExpressionAttributeValues[':PK']).toBe('TEMP');
    });

    test('should return 204 when no temp sensors found', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [],
        Count: 0
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(204);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      expect(result.body).toBeUndefined();
    });

    test('should handle single temp sensor', async () => {
      const singleSensor = [mockTempSensorData[0]];
      const enhancedSingleSensor = [enhancedMockTempSensorData[0]];
      docClientMock.on(QueryCommand).resolves({ 
        Items: singleSensor,
        Count: 1
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body).toEqual(enhancedSingleSensor);
      expect(body).toHaveLength(1);
    });

    test('should handle large number of temp sensors', async () => {
      const largeSensorList = Array.from({ length: 50 }, (_, i) => ({
        PK: 'TEMP',
        SK: `P${i.toString().padStart(5, '0')}`,
        family: i % 2 === 0 ? 'GPCR' : 'KINASE',
        alias: `TestSensor${i}`,
        status: 'pending'
      }));

      const enhancedLargeSensorList = largeSensorList.map(sensor => ({
        ...sensor,
        uniProtID: sensor.SK,
        submissionType: 'new',
        isEdit: false,
        originalSK: sensor.SK
      }));

      docClientMock.on(QueryCommand).resolves({ 
        Items: largeSensorList,
        Count: 50
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body).toHaveLength(50);
      expect(body).toEqual(enhancedLargeSensorList);
    });
  });

  describe('Error handling', () => {
    test('should handle DynamoDB query error', async () => {
      docClientMock.on(QueryCommand).rejects(new Error('DynamoDB query failed'));

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error on getting all process sensors, please check logs');
      expect(console.log).toHaveBeenCalledWith(expect.any(Error));
    });

    test('should handle DynamoDB access denied error', async () => {
      const accessDeniedError = new Error('User is not authorized to perform: dynamodb:Query');
      accessDeniedError.name = 'AccessDeniedException';
      
      docClientMock.on(QueryCommand).rejects(accessDeniedError);

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error on getting all process sensors, please check logs');
    });

    test('should handle DynamoDB throttling error', async () => {
      const throttlingError = new Error('Throughput exceeds the current capacity');
      throttlingError.name = 'ProvisionedThroughputExceededException';
      
      docClientMock.on(QueryCommand).rejects(throttlingError);

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Error on getting all process sensors, please check logs');
    });

    test('should handle malformed response from DynamoDB', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: undefined,
        Count: undefined
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
    });
  });

  describe('Request method handling', () => {
    test('should handle GET request correctly', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(docClientMock.calls()).toHaveLength(1);
    });

    test('should handle request without requestContext', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body).toEqual(enhancedMockTempSensorData);
    });

    test('should handle request without http method', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {},
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body).toEqual(enhancedMockTempSensorData);
    });
  });

  describe('Environment configuration', () => {
    test('should use correct table name from environment variable', async () => {
      process.env.TEMP_TABLE_NAME = 'custom-temp-table';
      
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      await handler(event);

      const queryCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'QueryCommand');
      expect(queryCall.args[0].input.TableName).toBe('custom-temp-table');
    });

    test('should handle missing environment variable gracefully', async () => {
      delete process.env.TEMP_TABLE_NAME;
      
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      await handler(event);

      const queryCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'QueryCommand');
      expect(queryCall.args[0].input.TableName).toBeUndefined();
    });
  });

  describe('Response structure', () => {
    test('should return correct response structure for successful request', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result).toHaveProperty('statusCode');
      expect(result).toHaveProperty('headers');
      expect(result).toHaveProperty('body');
      expect(result.statusCode).toBe(200);
      expect(result.headers).toHaveProperty('Access-Control-Allow-Origin');
      expect(result.headers).toHaveProperty('Access-Control-Allow-Credentials');
      expect(result.headers).toHaveProperty('Access-Control-Allow-Headers');
      expect(result.headers).toHaveProperty('Access-Control-Allow-Methods');
      expect(result.headers).toHaveProperty('Access-Control-Max-Age');
    });

    test('should return correct response structure for empty result', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: [],
        Count: 0
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result).toHaveProperty('statusCode');
      expect(result).toHaveProperty('headers');
      expect(result).not.toHaveProperty('body');
      expect(result.statusCode).toBe(204);
    });

    test('should return correct response structure for error', async () => {
      docClientMock.on(QueryCommand).rejects(new Error('Test error'));

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result).toHaveProperty('statusCode');
      expect(result).toHaveProperty('headers');
      expect(result).toHaveProperty('body');
      expect(result.statusCode).toBe(400);
      
      const body = JSON.parse(result.body);
      expect(body).toHaveProperty('message');
    });

    test('should return correct response structure for OPTIONS request', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'OPTIONS'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result).toHaveProperty('statusCode');
      expect(result).toHaveProperty('headers');
      expect(result).not.toHaveProperty('body');
      expect(result.statusCode).toBe(200);
    });
  });

  describe('Query parameters', () => {
    test('should use correct query parameters', async () => {
      docClientMock.on(QueryCommand).resolves({ 
        Items: mockTempSensorData,
        Count: 2
      });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      await handler(event);

      const queryCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'QueryCommand');
      const queryParams = queryCall.args[0].input;
      
      expect(queryParams.KeyConditionExpression).toBe('PK = :PK');
      expect(queryParams.ExpressionAttributeValues).toEqual({ ':PK': 'TEMP' });
      expect(queryParams.TableName).toBe('test-temp-table');
    });
  });
});

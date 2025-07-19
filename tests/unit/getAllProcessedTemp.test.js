import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/getAllProcessedTemp/getAllProcessedTemp.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('GetAllProcessedTemp Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TEMP_TABLE_NAME = 'test-temp-table';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockProcessedTempData = [
    {
      PK: 'GPCR',
      SK: 'P12345#ABOUT',
      alias: 'TestSensor1',
      family: 'GPCR',
      uniprotID: 'P12345'
    },
    {
      PK: 'KINASE',
      SK: 'P67890#ABOUT',
      alias: 'TestSensor2',
      family: 'KINASE',
      uniprotID: 'P67890'
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
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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
    test('should successfully retrieve processed temp sensors', async () => {
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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
      expect(body).toEqual(mockProcessedTempData);
      
      const scanCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'ScanCommand');
      expect(scanCall.args[0].input.TableName).toBe('test-temp-table');
    });

    test('should return 204 when no processed temp sensors found', async () => {
      docClientMock.on(ScanCommand).resolves({ 
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

    test('should handle single processed temp sensor', async () => {
      const singleSensor = [mockProcessedTempData[0]];
      docClientMock.on(ScanCommand).resolves({ 
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
      expect(body).toEqual(singleSensor);
      expect(body).toHaveLength(1);
    });

    test('should handle large number of processed temp sensors', async () => {
      const largeSensorList = Array.from({ length: 50 }, (_, i) => ({
        PK: i % 2 === 0 ? 'GPCR' : 'KINASE',
        SK: `P${i.toString().padStart(5, '0')}#ABOUT`,
        alias: `TestSensor${i}`,
        family: i % 2 === 0 ? 'GPCR' : 'KINASE',
        uniprotID: `P${i.toString().padStart(5, '0')}`
      }));

      docClientMock.on(ScanCommand).resolves({ 
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
      expect(body).toEqual(largeSensorList);
    });
  });

  describe('Error handling', () => {
    test('should handle DynamoDB scan error', async () => {
      docClientMock.on(ScanCommand).rejects(new Error('DynamoDB scan failed'));

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
      const accessDeniedError = new Error('User is not authorized to perform: dynamodb:Scan');
      accessDeniedError.name = 'AccessDeniedException';
      
      docClientMock.on(ScanCommand).rejects(accessDeniedError);

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
      
      docClientMock.on(ScanCommand).rejects(throttlingError);

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
      docClientMock.on(ScanCommand).resolves({ 
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

      expect(result.statusCode).toBe(200);
    });
  });

  describe('Request method handling', () => {
    test('should handle GET request correctly', async () => {
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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
      expect(body).toEqual(mockProcessedTempData);
    });

    test('should handle request without http method', async () => {
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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
      expect(body).toEqual(mockProcessedTempData);
    });
  });

  describe('Environment configuration', () => {
    test('should use correct table name from environment variable', async () => {
      process.env.TEMP_TABLE_NAME = 'custom-temp-table';
      
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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

      const scanCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'ScanCommand');
      expect(scanCall.args[0].input.TableName).toBe('custom-temp-table');
    });

    test('should handle missing environment variable gracefully', async () => {
      delete process.env.TEMP_TABLE_NAME;
      
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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

      const scanCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'ScanCommand');
      expect(scanCall.args[0].input.TableName).toBeUndefined();
    });
  });

  describe('Response structure', () => {
    test('should return correct response structure for successful request', async () => {
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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
      docClientMock.on(ScanCommand).resolves({ 
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
      docClientMock.on(ScanCommand).rejects(new Error('Test error'));

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

  describe('Scan parameters', () => {
    test('should use correct scan parameters', async () => {
      docClientMock.on(ScanCommand).resolves({ 
        Items: mockProcessedTempData,
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

      const scanCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'ScanCommand');
      const scanParams = scanCall.args[0].input;
      
      expect(scanParams.TableName).toBe('test-temp-table');
      expect(scanParams.ExpressionAttributeNames).toEqual({
        "#PK": "PK",
        '#alias': 'alias',
        '#family': 'family',
        '#uni': 'uniprotID'
      });
      expect(scanParams.ExpressionAttributeValues).toEqual({
        ':PK': 'TEMP',
        ':op': 'operator',
        ':struct': 'structure',
        ':lin': 'lineage',
        ':operon': 'operon',
        ':ligs': 'ligands'
      });
      expect(scanParams.ProjectionExpression).toBe('#alias, #family, #uni, PK, SK');
      expect(scanParams.FilterExpression).toBe('not(contains(category, :op)) and not(contains(category, :struct)) and not(contains(category, :lin)) and not(contains(category, :operon)) and not(contains(category, :ligs)) and #PK <> :PK');
    });

    test('should filter out specific categories', async () => {
      const filteredData = [
        {
          PK: 'GPCR',
          SK: 'P12345#ABOUT',
          alias: 'TestSensor1',
          family: 'GPCR',
          uniprotID: 'P12345'
        }
      ];

      docClientMock.on(ScanCommand).resolves({ 
        Items: filteredData,
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
      expect(body).toEqual(filteredData);
      
      const scanCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'ScanCommand');
      const filterExpression = scanCall.args[0].input.FilterExpression;
      expect(filterExpression).toContain('not(contains(category, :op))');
      expect(filterExpression).toContain('not(contains(category, :struct))');
      expect(filterExpression).toContain('not(contains(category, :lin))');
      expect(filterExpression).toContain('not(contains(category, :operon))');
      expect(filterExpression).toContain('not(contains(category, :ligs))');
      expect(filterExpression).toContain('#PK <> :PK');
    });
  });
});

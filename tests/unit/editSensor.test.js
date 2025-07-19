import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/editSensor/editSensor.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('EditSensor Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TABLE_NAME = 'test-prod-table';
    process.env.TEMP_TABLE_NAME = 'test-temp-table';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const validSensorData = {
    uniProtID: 'P12345',
    family: 'OTHER',
    about: {
      about: 'Test sensor description',
      accession: 'TEST_ACC',
      alias: 'TestSensor',
      mechanism: 'Apo-repressor'
    },
    operator: {
      data: [
        {
          doi: '10.1234/test',
          method: 'EMSA',
          ref_figure: 'Figure 1',
          sequence: 'ATCGATCG'
        }
      ]
    },
    ligands: {
      data: [
        {
          doi: '10.1234/test',
          method: 'EMSA',
          ref_figure: 'Figure 2',
          name: 'Test Ligand',
          SMILES: 'CCO'
        }
      ]
    },
    lineage: {
      child_id: '',
      mutation: '',
      parent_id: '',
      doi: ''
    },
    user: 'testuser@example.com',
    timeSubmit: 1234567890
  };

  const existingSensorInProd = {
    PK: 'OTHER',
    SK: 'P12345#ABOUT',
    alias: 'ExistingSensor',
    family: 'OTHER'
  };

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
      expect(result.headers['Access-Control-Allow-Methods']).toBe('POST,OPTIONS');
    });

    test('should use allowed origin for groov.bio', async () => {
      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: existingSensorInProd })
        .resolvesOnce({ Item: null });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use default origin for disallowed origins', async () => {
      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: existingSensorInProd })
        .resolvesOnce({ Item: null });
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://malicious-site.com'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Successful edit submission', () => {
    test('should successfully submit sensor edit', async () => {
      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: existingSensorInProd })
        .resolvesOnce({ Item: null });
      
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Edit submitted successfully and is pending admin review');

      const putCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'PutCommand');
      expect(putCall).toBeTruthy();
      expect(putCall.args[0].input.TableName).toBe('test-temp-table');
      expect(putCall.args[0].input.Item.PK).toBe('TEMP');
      expect(putCall.args[0].input.Item.SK).toBe('P12345#EDIT');
      expect(putCall.args[0].input.Item.isEdit).toBe(true);
      expect(putCall.args[0].input.Item.editTimestamp).toBeDefined();
    });

    test('should handle edit for different families', async () => {
      const tetrSensorData = {
        ...validSensorData,
        family: 'TETR',
        uniProtID: 'Q98765'
      };

      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: { ...existingSensorInProd, PK: 'TETR', SK: 'Q98765#ABOUT' } })
        .resolvesOnce({ Item: null });
      
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(tetrSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      
      const putCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'PutCommand');
      expect(putCall.args[0].input.Item.SK).toBe('Q98765#EDIT');
    });
  });

  describe('Validation', () => {
    test('should handle missing request body', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Missing request body');
    });

    test('should handle invalid JSON in request body', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: 'invalid json{'
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Invalid JSON in request body');
    });

    test('should validate required fields', async () => {
      const invalidData = {
        family: 'GPCR'
      };

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(invalidData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
      expect(body.message.errors).toBeInstanceOf(Array);
    });

    test('should validate family values', async () => {
      const invalidFamilyData = {
        ...validSensorData,
        family: 'INVALID_FAMILY'
      };

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(invalidFamilyData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
    });

    test('should validate operator method values', async () => {
      const invalidOperatorData = {
        ...validSensorData,
        operator: {
          data: [
            {
              doi: '10.1234/test',
              method: 'INVALID_METHOD',
              ref_figure: 'Figure 1',
              sequence: 'ATCGATCG'
            }
          ]
        }
      };

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(invalidOperatorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
    });

    test('should validate sequence format', async () => {
      const invalidSequenceData = {
        ...validSensorData,
        operator: {
          data: [
            {
              doi: '10.1234/test',
              method: 'EMSA',
              ref_figure: 'Figure 1',
              sequence: 'INVALID123'
            }
          ]
        }
      };

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(invalidSequenceData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
    });
  });

  describe('Sensor existence checks', () => {
    test('should return 404 when sensor does not exist in production', async () => {
      docClientMock.on(GetCommand).resolvesOnce({ Item: null });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.message).toBe("Sensor not found in production database. Cannot edit a sensor that doesn't exist.");
    });

    test('should return 409 when edit is already pending', async () => {
      const pendingEdit = {
        PK: 'TEMP',
        SK: 'P12345#EDIT',
        family: 'GPCR',
        isEdit: true
      };

      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: existingSensorInProd })
        .resolvesOnce({ Item: pendingEdit });

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('An edit for this sensor is already pending review. Please wait for the current edit to be processed.');
    });
  });

  describe('Error handling', () => {
    test('should handle DynamoDB errors when checking sensor existence', async () => {
      docClientMock.on(GetCommand).rejectsOnce(new Error('DynamoDB error'));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.message).toBe("Sensor not found in production database. Cannot edit a sensor that doesn't exist.");
    });

    test('should handle DynamoDB errors when writing edit', async () => {
      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: existingSensorInProd })
        .resolvesOnce({ Item: null });
      
      docClientMock.on(PutCommand).rejects(new Error('Write failed'));

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Error writing edit to temp table');
    });

    test('should handle unhandled exceptions', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const originalParse = JSON.parse;
      JSON.parse = jest.fn().mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      
      JSON.parse = originalParse;
    });
  });

  describe('Environment configuration', () => {
    test('should use correct table names from environment variables', async () => {
      process.env.TABLE_NAME = 'custom-prod-table';
      process.env.TEMP_TABLE_NAME = 'custom-temp-table';

      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: existingSensorInProd })
        .resolvesOnce({ Item: null });
      
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      
      const getCalls = docClientMock.calls().filter(call => call.args[0].constructor.name === 'GetCommand');
      expect(getCalls.length).toBeGreaterThan(0);
      expect(getCalls[0].args[0].input.TableName).toBe('custom-prod-table');
      
      const putCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'PutCommand');
      expect(putCall.args[0].input.TableName).toBe('custom-temp-table');
    });

    test('should work with IS_LOCAL environment variable', async () => {
      process.env.IS_LOCAL = 'true';

      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: existingSensorInProd })
        .resolvesOnce({ Item: null });
      
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(validSensorData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      
      delete process.env.IS_LOCAL;
    });
  });

  describe('Data validation edge cases', () => {
    test('should handle minimal valid data', async () => {
      const minimalData = {
        uniProtID: 'P99999',
        family: 'OTHER',
        about: {
          accession: 'ACC999',
          alias: 'MinSensor'
        },
        operator: {
          data: []
        },
        ligands: {
          data: []
        },
        lineage: {
          child_id: '',
          mutation: '',
          parent_id: '',
          doi: ''
        }
      };

      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: { ...existingSensorInProd, PK: 'OTHER', SK: 'P99999#ABOUT' } })
        .resolvesOnce({ Item: null });
      
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(minimalData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });

    test('should validate ligand SMILES format', async () => {
      const ligandData = {
        ...validSensorData,
        ligands: {
          data: [
            {
              doi: '10.1234/test',
              method: 'EMSA',
              ref_figure: 'Figure 2',
              name: 'Test Ligand',
              SMILES: 'C1=CC=CC=C1'
            }
          ]
        }
      };

      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: existingSensorInProd })
        .resolvesOnce({ Item: null });
      
      docClientMock.on(PutCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(ligandData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
    });

    test('should validate figure reference format', async () => {
      const invalidFigureData = {
        ...validSensorData,
        operator: {
          data: [
            {
              doi: '10.1234/test',
              method: 'EMSA',
              ref_figure: 'Invalid Figure',
              sequence: 'ATCGATCG'
            }
          ]
        }
      };

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        body: JSON.stringify(invalidFigureData)
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
    });
  });
}); 
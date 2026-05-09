import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/insertFormV2/insertForm.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('InsertFormV2 Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TABLE_NAME = 'test-prod-table';
    process.env.TEMP_TABLE_V2_NAME = 'test-temp-v2-table';
    delete process.env.IS_LOCAL;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const validFormData = {
    uniProtID: 'P12345',
    family: 'TETR',
    about: {
      about: 'Test sensor description',
      accession: 'TEST_ACC',
      alias: 'TestAlias',
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
          doi: '10.1234/ligand',
          method: 'EMSA',
          ref_figure: 'Figure 2',
          name: 'TestLigand',
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
    user: 'testuser',
    timeSubmit: 1640995200000
  };

  describe('CORS handling', () => {
    test('should handle OPTIONS request', async () => {
      const event = {
        requestContext: { http: { method: 'OPTIONS' } },
        headers: { origin: 'https://groov.bio' }
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use allowed origin for groov.bio', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validFormData)
      };
      const result = await handler(event);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });
  });

  describe('Request validation', () => {
    test('should accept valid form data', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validFormData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(202);
    });

    test('should return validation error for missing required fields', async () => {
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ family: 'TETR' })
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message.type).toBe('Validation Error');
    });

    test('should return validation error for invalid family', async () => {
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({ ...validFormData, family: 'INVALID_FAMILY' })
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });

    test('should return validation error for invalid ref_figure format', async () => {
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify({
          ...validFormData,
          operator: { data: [{ doi: '10.1234/test', method: 'EMSA', ref_figure: 'Invalid Figure Format', sequence: 'ATCGATCG' }] }
        })
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });
  });

  describe('v2 schema — Supplementary ref_figure formats', () => {
    test('should accept Supplementary Figure ref_figure', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});
      const testCases = ['Supplementary Figure 1', 'Supplementary Figure 2A', 'Supplementary Table 1'];
      for (const refFigure of testCases) {
        docClientMock.reset();
        docClientMock.on(GetCommand).resolves({ Item: undefined });
        docClientMock.on(PutCommand).resolves({});
        const event = {
          requestContext: { http: { method: 'POST' } },
          headers: { origin: 'https://groov.bio' },
          body: JSON.stringify({
            ...validFormData,
            operator: { data: [{ doi: '10.1234/test', method: 'EMSA', ref_figure: refFigure, sequence: 'ATCGATCG' }] }
          })
        };
        const result = await handler(event);
        expect(result.statusCode).toBe(202);
      }
    });
  });

  describe('Duplicate checking', () => {
    test('should return error for production database duplicate', async () => {
      docClientMock.on(GetCommand).resolvesOnce({ Item: { PK: 'TETR', SK: 'P12345#ABOUT' } });
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validFormData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.message).toBe("This uniProtID already exists in our database. If there's an issue, please submit a bug report.");
    });

    test('should return error for v2 temp database duplicate', async () => {
      docClientMock.on(GetCommand)
        .resolvesOnce({ Item: undefined })
        .resolvesOnce({ Item: { PK: 'TEMP', SK: 'P12345' } });
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validFormData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.message).toBe("A submission for this uniProtID is already pending. If there's an issue, please submit a bug report.");
    });

    test('should check prod table first then v2 temp table', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validFormData)
      };
      await handler(event);
      const getCalls = docClientMock.calls().filter(call => call.args[0].constructor.name === 'GetCommand');
      expect(getCalls).toHaveLength(2);
      expect(getCalls[0].args[0].input.TableName).toBe('test-prod-table');
      expect(getCalls[0].args[0].input.Key).toEqual({ PK: 'TETR', SK: 'P12345#ABOUT' });
      expect(getCalls[1].args[0].input.TableName).toBe('test-temp-v2-table');
      expect(getCalls[1].args[0].input.Key).toEqual({ PK: 'TEMP', SK: 'P12345' });
    });
  });

  describe('Database write operations', () => {
    test('should write to v2 temp table', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validFormData)
      };
      await handler(event);
      const putCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'PutCommand');
      expect(putCall).toBeDefined();
      expect(putCall.args[0].input.TableName).toBe('test-temp-v2-table');
      expect(putCall.args[0].input.Item.PK).toBe('TEMP');
      expect(putCall.args[0].input.Item.SK).toBe('P12345');
    });

    test('should return 500 when write fails', async () => {
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).rejects(new Error('Write failed'));
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validFormData)
      };
      const result = await handler(event);
      expect(result.statusCode).toBe(500);
    });
  });

  describe('Environment configuration', () => {
    test('should use correct table names from environment variables', async () => {
      process.env.TABLE_NAME = 'custom-prod-table';
      process.env.TEMP_TABLE_V2_NAME = 'custom-temp-v2-table';
      docClientMock.on(GetCommand).resolves({ Item: undefined });
      docClientMock.on(PutCommand).resolves({});
      const event = {
        requestContext: { http: { method: 'POST' } },
        headers: { origin: 'https://groov.bio' },
        body: JSON.stringify(validFormData)
      };
      await handler(event);
      const getCalls = docClientMock.calls().filter(call => call.args[0].constructor.name === 'GetCommand');
      expect(getCalls[0].args[0].input.TableName).toBe('custom-prod-table');
      expect(getCalls[1].args[0].input.TableName).toBe('custom-temp-v2-table');
      const putCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'PutCommand');
      expect(putCall.args[0].input.TableName).toBe('custom-temp-v2-table');
    });
  });
});

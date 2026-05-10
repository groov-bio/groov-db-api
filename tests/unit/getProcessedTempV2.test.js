import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/getProcessedTempV2/getProcessedTemp.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
});

const baseEvent = (overrides = {}) => ({
  requestContext: { http: { method: 'GET' } },
  headers: { origin: 'https://groov.bio' },
  queryStringParameters: { category: 'TetR', submissionUUID: 'uuid-1' },
  ...overrides,
});

describe('GetProcessedTempV2', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.PROCESSED_TEMP_TABLE_V2_NAME = 'test-processed-v2-table';
  });

  test('OPTIONS preflight returns 200', async () => {
    const res = await handler(baseEvent({ requestContext: { http: { method: 'OPTIONS' } } }));
    expect(res.statusCode).toBe(200);
  });

  test('returns 400 when category missing', async () => {
    const res = await handler(baseEvent({ queryStringParameters: { submissionUUID: 'uuid-1' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/category/);
  });

  test('returns 400 when submissionUUID missing', async () => {
    const res = await handler(baseEvent({ queryStringParameters: { category: 'TetR' } }));
    expect(res.statusCode).toBe(400);
  });

  test('returns 400 when queryStringParameters absent', async () => {
    const res = await handler(baseEvent({ queryStringParameters: undefined }));
    expect(res.statusCode).toBe(400);
  });

  test('returns 200 with mapped row on happy path', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: {
        PK: 'TetR',
        SK: 'uuid-1',
        proposed_grv_id: 'GRV-ABC',
        data: { id: null, category: 'TetR', proteins: [{ uniprot_id: 'P12345' }] },
      },
    });

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      category: 'TetR',
      submissionUUID: 'uuid-1',
      proposed_grv_id: 'GRV-ABC',
      data: { id: null, category: 'TetR', proteins: [{ uniprot_id: 'P12345' }] },
    });

    const call = docClientMock.calls()[0];
    expect(call.args[0].input.TableName).toBe('test-processed-v2-table');
    expect(call.args[0].input.Key).toEqual({ PK: 'TetR', SK: 'uuid-1' });
  });

  test('returns 404 when row not found', async () => {
    docClientMock.on(GetCommand).resolves({});
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(404);
  });

  test('returns 500 when DynamoDB throws', async () => {
    docClientMock.on(GetCommand).rejects(new Error('boom'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
  });
});

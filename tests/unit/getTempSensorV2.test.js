import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/getTempSensorV2/getTempSensor.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
});

const baseEvent = (overrides = {}) => ({
  requestContext: { http: { method: 'GET' } },
  headers: { origin: 'https://groov.bio' },
  queryStringParameters: { submissionUUID: 'uuid-1' },
  ...overrides,
});

describe('GetTempSensorV2', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TEMP_TABLE_V2_NAME = 'test-temp-v2-table';
  });

  test('OPTIONS preflight returns 200', async () => {
    const res = await handler(baseEvent({ requestContext: { http: { method: 'OPTIONS' } } }));
    expect(res.statusCode).toBe(200);
  });

  test('returns 400 when submissionUUID is missing', async () => {
    const res = await handler(baseEvent({ queryStringParameters: {} }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/submissionUUID/);
  });

  test('returns 400 when queryStringParameters is absent', async () => {
    const res = await handler(baseEvent({ queryStringParameters: undefined }));
    expect(res.statusCode).toBe(400);
  });

  test('returns 200 with single submission on happy path', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: {
        PK: 'TEMP',
        SK: 'uuid-1',
        user: 'alice',
        timeSubmit: 1700000000,
        sensor: { category: 'TetR', proteins: [{ uniProtID: 'P12345' }] },
      },
    });

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      submissionUUID: 'uuid-1',
      user: 'alice',
      timeSubmit: 1700000000,
      sensor: { category: 'TetR', proteins: [{ uniProtID: 'P12345' }] },
    });

    const call = docClientMock.calls()[0];
    expect(call.args[0].input.TableName).toBe('test-temp-v2-table');
    expect(call.args[0].input.Key).toEqual({ PK: 'TEMP', SK: 'uuid-1' });
  });

  test('returns 404 when submission not found', async () => {
    docClientMock.on(GetCommand).resolves({});
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).message).toMatch(/not found/i);
  });

  test('returns 500 when DynamoDB throws', async () => {
    docClientMock.on(GetCommand).rejects(new Error('boom'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
  });
});

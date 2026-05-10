import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/deleteTempV2/deleteTemp.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
});

const baseEvent = (overrides = {}) => ({
  requestContext: { http: { method: 'POST' } },
  headers: { origin: 'https://groov.bio' },
  body: JSON.stringify({ submissionUUID: 'uuid-1' }),
  ...overrides,
});

describe('DeleteTempV2', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TEMP_TABLE_V2_NAME = 'test-temp-v2-table';
  });

  test('OPTIONS preflight returns 200 with POST,OPTIONS allowed', async () => {
    const res = await handler(baseEvent({ requestContext: { http: { method: 'OPTIONS' } } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Methods']).toBe('POST,OPTIONS');
  });

  test('returns 400 on invalid JSON', async () => {
    const res = await handler(baseEvent({ body: '{not json' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/invalid json/i);
  });

  test('returns 400 when submissionUUID missing from body', async () => {
    const res = await handler(baseEvent({ body: JSON.stringify({}) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/submissionUUID/);
  });

  test('returns 400 when body is null', async () => {
    const res = await handler(baseEvent({ body: null }));
    expect(res.statusCode).toBe(400);
  });

  test('returns 204 on successful delete and uses correct key', async () => {
    docClientMock.on(DeleteCommand).resolves({
      Attributes: { PK: 'TEMP', SK: 'uuid-1', sensor: {} },
    });

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();

    const call = docClientMock.calls()[0];
    expect(call.args[0].input.TableName).toBe('test-temp-v2-table');
    expect(call.args[0].input.Key).toEqual({ PK: 'TEMP', SK: 'uuid-1' });
    expect(call.args[0].input.ReturnValues).toBe('ALL_OLD');
  });

  test('returns 404 when no row was deleted', async () => {
    docClientMock.on(DeleteCommand).resolves({});
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).message).toMatch(/not found/i);
  });

  test('returns 500 when DynamoDB throws', async () => {
    docClientMock.on(DeleteCommand).rejects(new Error('boom'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
  });
});

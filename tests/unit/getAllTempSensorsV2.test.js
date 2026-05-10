import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/getAllTempSensorsV2/getAllTempSensors.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
});

const baseEvent = (overrides = {}) => ({
  requestContext: { http: { method: 'GET' } },
  headers: { origin: 'https://groov.bio' },
  ...overrides,
});

describe('GetAllTempSensorsV2', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.TEMP_TABLE_V2_NAME = 'test-temp-v2-table';
  });

  test('OPTIONS preflight returns 200 with CORS headers', async () => {
    const res = await handler(baseEvent({ requestContext: { http: { method: 'OPTIONS' } } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    expect(res.headers['Access-Control-Allow-Methods']).toBe('GET,OPTIONS');
  });

  test('returns 200 with mapped submissions on happy path', async () => {
    docClientMock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'TEMP',
          SK: 'uuid-1',
          user: 'alice',
          timeSubmit: 1700000000,
          sensor: { category: 'TetR', proteins: [{ uniProtID: 'P12345' }] },
        },
        {
          PK: 'TEMP',
          SK: 'uuid-2',
          user: 'bob',
          timeSubmit: 1700000001,
          sensor: { category: 'LysR', proteins: [{ uniProtID: 'Q67890' }] },
        },
      ],
    });

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.submissions).toHaveLength(2);
    expect(body.submissions[0]).toEqual({
      submissionUUID: 'uuid-1',
      user: 'alice',
      timeSubmit: 1700000000,
      sensor: { category: 'TetR', proteins: [{ uniProtID: 'P12345' }] },
    });
    expect(body.submissions[1].submissionUUID).toBe('uuid-2');

    const call = docClientMock.calls()[0];
    expect(call.args[0].input.TableName).toBe('test-temp-v2-table');
    expect(call.args[0].input.KeyConditionExpression).toBe('PK = :PK');
    expect(call.args[0].input.ExpressionAttributeValues).toEqual({ ':PK': 'TEMP' });
  });

  test('returns 204 when table is empty', async () => {
    docClientMock.on(QueryCommand).resolves({ Items: [] });
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
  });

  test('paginates through LastEvaluatedKey and merges all items', async () => {
    docClientMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ PK: 'TEMP', SK: 'uuid-1', sensor: { category: 'TetR' } }],
        LastEvaluatedKey: { PK: 'TEMP', SK: 'uuid-1' },
      })
      .resolvesOnce({
        Items: [{ PK: 'TEMP', SK: 'uuid-2', sensor: { category: 'LysR' } }],
      });

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.submissions).toHaveLength(2);
    expect(docClientMock.calls()).toHaveLength(2);
    expect(docClientMock.calls()[1].args[0].input.ExclusiveStartKey).toEqual({ PK: 'TEMP', SK: 'uuid-1' });
  });

  test('returns 500 when DynamoDB throws', async () => {
    docClientMock.on(QueryCommand).rejects(new Error('boom'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).message).toMatch(/error/i);
  });

  test('disallowed origin falls back to localhost default', async () => {
    docClientMock.on(QueryCommand).resolves({ Items: [] });
    const res = await handler(baseEvent({ headers: { origin: 'https://evil.com' } }));
    expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
  });

  test('null user/timeSubmit/sensor are returned as nulls', async () => {
    docClientMock.on(QueryCommand).resolves({
      Items: [{ PK: 'TEMP', SK: 'uuid-only' }],
    });
    const res = await handler(baseEvent());
    const body = JSON.parse(res.body);
    expect(body.submissions[0]).toEqual({
      submissionUUID: 'uuid-only',
      user: null,
      timeSubmit: null,
      sensor: null,
    });
  });
});

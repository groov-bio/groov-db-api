import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/getAllProcessedTempV2/getAllProcessedTemp.js');

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

describe('GetAllProcessedTempV2', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.PROCESSED_TEMP_TABLE_V2_NAME = 'test-processed-v2-table';
  });

  test('OPTIONS preflight returns 200', async () => {
    const res = await handler(baseEvent({ requestContext: { http: { method: 'OPTIONS' } } }));
    expect(res.statusCode).toBe(200);
  });

  test('returns 200 with mapped processed rows', async () => {
    docClientMock.on(ScanCommand).resolves({
      Items: [
        {
          PK: 'TetR',
          SK: 'uuid-1',
          proposed_grv_id: null,
          data: { id: null, type: 'One Component', category: 'TetR', proteins: [] },
        },
        {
          PK: 'LysR',
          SK: 'uuid-2',
          proposed_grv_id: 'GRV-XYZ',
          data: { id: null, type: 'Two Component', category: 'LysR', proteins: [] },
        },
      ],
    });

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.processed).toHaveLength(2);
    expect(body.processed[0]).toEqual({
      category: 'TetR',
      submissionUUID: 'uuid-1',
      proposed_grv_id: null,
      data: { id: null, type: 'One Component', category: 'TetR', proteins: [] },
    });
    expect(body.processed[1].proposed_grv_id).toBe('GRV-XYZ');

    const call = docClientMock.calls()[0];
    expect(call.args[0].input.TableName).toBe('test-processed-v2-table');
  });

  test('returns 204 when table is empty', async () => {
    docClientMock.on(ScanCommand).resolves({ Items: [] });
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(204);
  });

  test('paginates through LastEvaluatedKey', async () => {
    docClientMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [{ PK: 'TetR', SK: 'uuid-1', data: {} }],
        LastEvaluatedKey: { PK: 'TetR', SK: 'uuid-1' },
      })
      .resolvesOnce({
        Items: [{ PK: 'LysR', SK: 'uuid-2', data: {} }],
      });

    const res = await handler(baseEvent());
    const body = JSON.parse(res.body);
    expect(body.processed).toHaveLength(2);
    expect(docClientMock.calls()).toHaveLength(2);
    expect(docClientMock.calls()[1].args[0].input.ExclusiveStartKey).toEqual({ PK: 'TetR', SK: 'uuid-1' });
  });

  test('returns 500 when scan throws', async () => {
    docClientMock.on(ScanCommand).rejects(new Error('boom'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
  });

  test('handles missing proposed_grv_id and data fields by emitting null', async () => {
    docClientMock.on(ScanCommand).resolves({
      Items: [{ PK: 'TetR', SK: 'uuid-1' }],
    });
    const res = await handler(baseEvent());
    const body = JSON.parse(res.body);
    expect(body.processed[0]).toEqual({
      category: 'TetR',
      submissionUUID: 'uuid-1',
      proposed_grv_id: null,
      data: null,
    });
  });
});

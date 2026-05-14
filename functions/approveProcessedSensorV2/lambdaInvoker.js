import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({ region: 'us-east-2' });

export const invokeFingerprintAsync = async (payload) => {
  const fnName = process.env.FINGERPRINT_LAMBDA_NAME;
  if (!fnName) {
    console.log('FINGERPRINT_LAMBDA_NAME not set, skipping fingerprint invocation');
    return;
  }
  await lambdaClient.send(new InvokeCommand({
    FunctionName: fnName,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
};

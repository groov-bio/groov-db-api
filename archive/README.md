# Archive

The archive directory is previous function code which is no longer used following the introduction of static JSON assets being fetched.

However, the code is still a part of the project history so keeping it for now.

## 2026-07-11: V1 API functions archived

On 2026-07-11, the following 11 V1 (Node.js) Lambda functions were archived here after
the V2 (Python) API went live and fully replaced them: `addNewSensor`, `approveProcessedSensor`,
`deleteTemp`, `editSensor`, `getAllProcessedTemp`, `getAllTempSensors`, `getProcessedTemp`,
`getTempSensor`, `insertForm`, `rejectProcessedSensor`, `updateFingerprint`. Their endpoints
(and the `AWS::Serverless::Function` resources backing them) were removed from `template.yaml`
and `template-local.yaml` so they no longer deploy.
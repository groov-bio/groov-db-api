import { CognitoJwtVerifier } from "aws-jwt-verify";

const verifier = CognitoJwtVerifier.create({
    userPoolId: `${process.env.USER_POOL_ID}`,
    tokenUse: "id",
    clientId: `${process.env.USER_POOL_CLIENT_ID}`,
    groups: `${process.env.ADMIN_GROUP}`
});

// One more timeeeeee

export const handler = async (event) => {
    const token = event.headers.authorization;
 
    try {
        console.log('Admin verified')
        await verifier.verify(token);
        return {
            isAuthorized: true
        };
    } catch (err) {
        console.log(`err: ${err}`)
        return {
            isAuthorized: false
        }
    }
}
# Service-Meow

This application is intended to demo and experiment with Azure AD. Specifically its purpose is to demonstrate
how an enterprise could provide self-service enterprise application registration to developer teams.

## To run
Have Node.js 12+

Create a .env file with the following properties:

```
CLIENT_ID
CLIENT_SECRET
TENNANT_ID
REDIRECT_URI
SESSION_SECRET
COSMOS_DB_KEY
```

You need to create an app registration in Azure AD and give it permissions to read/write applications on its own. Once created, you can get the client id, secret, and redirect uri.This application uses Azure Cosmos DB, so you'll need to provision a database and provide the key too. The session secret is used for signing and encrypting cookies so make it whatever you want. Longer is better. Tennant ID is your azure tennant ID.
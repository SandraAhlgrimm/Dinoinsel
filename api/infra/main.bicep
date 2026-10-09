targetScope = 'resourceGroup'

@description('A globally unique, lowercase Function App name. No resources are created until an adult explicitly deploys this template.')
@minLength(2)
@maxLength(60)
param appName string

@description('Azure region with Flex Consumption and Node.js 24 support. Check current regional availability before deploying.')
param location string = resourceGroup().location

@description('Exact HTTPS game origins, without path or trailing slash. Never use a wildcard. Example: https://YOUR-ACCOUNT.github.io')
@minLength(1)
@maxLength(10)
param gameOrigins array

@description('On-demand scale ceiling, not a spending cap. The current Flex minimum is 1. No always-ready instances are configured.')
@minValue(1)
@maxValue(10)
param maximumInstanceCount int = 1

var suffix = uniqueString(resourceGroup().id, appName)
var tableName = 'Dinoinsel'
var packageContainerName = 'function-packages'
var blobOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var tableContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var tags = {
  application: 'Dinoinsel'
  purpose: 'private-friends-leaderboard'
}

resource hostStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'dinohost${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
  }
}

resource hostBlobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: hostStorage
  name: 'default'
}

resource packages 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: hostBlobs
  name: packageContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource gameStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'dinodata${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
  }
}

resource gameTables 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: gameStorage
  name: 'default'
  properties: {
    cors: { corsRules: [] }
  }
}

resource gameTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: gameTables
  name: tableName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-identity'
  location: location
  tags: tags
}

// The host needs to create/lease its own blob containers. Its account contains no game profiles.
resource hostBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, identity.id, blobOwnerRoleId)
  scope: hostStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobOwnerRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource gameTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(gameTable.id, identity.id, tableContributorRoleId)
  scope: gameTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableContributorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${appName}-plan'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      remoteDebuggingEnabled: false
      httpLoggingEnabled: false
      detailedErrorLoggingEnabled: false
      requestTracingEnabled: false
      cors: {
        allowedOrigins: filter(gameOrigins, origin => startsWith(origin, 'https://') && !contains(origin, '*'))
        supportCredentials: false
      }
    }
    functionAppConfig: {
      runtime: {
        name: 'node'
        version: '24'
      }
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${hostStorage.properties.primaryEndpoints.blob}${packages.name}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: identity.id
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: maximumInstanceCount
        instanceMemoryMB: 512
        alwaysReady: []
        triggers: {
          http: {
            perInstanceConcurrency: 4
          }
        }
      }
    }
  }
  dependsOn: [hostBlobRole, gameTableRole]
}

resource settings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: {
    AzureWebJobsStorage__accountName: hostStorage.name
    AzureWebJobsStorage__credential: 'managedidentity'
    AzureWebJobsStorage__clientId: identity.properties.clientId
    STORAGE_MODE: 'managed-identity'
    TABLE_ENDPOINT: gameStorage.properties.primaryEndpoints.table
    TABLE_NAME: tableName
    MANAGED_IDENTITY_CLIENT_ID: identity.properties.clientId
    ALLOWED_ORIGINS: join(gameOrigins, ',')
    FUNCTIONS_REQUEST_BODY_SIZE_LIMIT: '4096'
    AZURE_LOG_LEVEL: ''
  }
}

resource noFtpBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: functionApp
  name: 'ftp'
  properties: {
    allow: false
  }
}

resource noScmBasicAuth 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: functionApp
  name: 'scm'
  properties: {
    allow: false
  }
}

output apiBaseOrigin string = 'https://${functionApp.properties.defaultHostName}'
output functionAppName string = functionApp.name
output gameStorageAccountName string = gameStorage.name
output leaderboardTableName string = tableName

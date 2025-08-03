import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

export interface Credentials {
  username: string;
  password: string;
  token?: string;
  expiresAt?: number;
}

export class SecretsManagerService {
  private client: SecretManagerServiceClient;
  private projectId: string;

  constructor() {
    this.client = new SecretManagerServiceClient();
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT || 'neonbinder';
  }
  async getCredentials(key: string): Promise<Credentials> {
    try {
      const secretName = `projects/${this.projectId}/secrets/${key}`;
      
      const [versions] = await this.client.listSecretVersions({
        parent: secretName,
      });

      const activeVersion = versions.find(v => v.state === 'ENABLED');
      if (!activeVersion?.name) {
        throw new Error(`No active version found for secret: ${key}`);
      }

      const [version] = await this.client.accessSecretVersion({
        name: activeVersion.name,
      });

      if (!version.payload?.data) {
        throw new Error(`No data found in secret: ${key}`);
      }

      const secretData = version.payload.data.toString();
      const credentials = JSON.parse(secretData);

      if (!credentials.username || !credentials.password) {
        throw new Error(`Invalid credentials format in secret: ${key}`);
      }

      return {
        username: credentials.username,
        password: credentials.password,
        token: credentials.token,
        expiresAt: credentials.expiresAt
      };
    } catch (error) {
      throw new Error(`Failed to retrieve credentials for key '${key}': ${error}`);
    }
  }

  async listSecrets(): Promise<string[]> {
    try {
      const [secrets] = await this.client.listSecrets({
        parent: `projects/${this.projectId}`,
      });

      return secrets.map(secret => {
        const name = secret.name || '';
        return name.split('/').pop() || '';
      });
    } catch (error) {
      console.error('Failed to list secrets:', error);
      return [];
    }
  }

  /**
   * Updates (adds a new version to) the secret with the given key, storing the provided credentials object as JSON.
   * If the secret does not exist, it will be created.
   */
  async updateCredentials(key: string, credentials: Credentials): Promise<void> {
    const secretId = key;
    const parent = `projects/${this.projectId}`;
    const secretName = `${parent}/secrets/${secretId}`;
    const payload = JSON.stringify(credentials);
    try {
      // Try to add a new version to the secret
      await this.client.addSecretVersion({
        parent: secretName,
        payload: { data: Buffer.from(payload, 'utf8') },
      });
    } catch (err: any) {
      // If the secret does not exist, create it and then add the version
      if (err.code === 5 || (err.message && err.message.includes('not found'))) {
        // Create the secret
        await this.client.createSecret({
          parent,
          secretId,
          secret: {
            replication: { automatic: {} },
          },
        });
        // Add the version
        await this.client.addSecretVersion({
          parent: secretName,
          payload: { data: Buffer.from(payload, 'utf8') },
        });
      } else {
        throw new Error(`Failed to update credentials for key '${key}': ${err}`);
      }
    }
  }
} 
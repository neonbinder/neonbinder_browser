import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

export interface Credentials {
  username: string;
  password: string;
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
      const secretName = `projects/${this.projectId}/secrets/${key}/versions/latest`;
      
      const [version] = await this.client.accessSecretVersion({
        name: secretName,
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
        password: credentials.password
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
} 
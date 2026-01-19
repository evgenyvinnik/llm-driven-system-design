import { query } from '../utils/database.js';
import { redis, cacheGet, cacheSet } from '../utils/redis.js';

export interface ChannelTemplate {
  title?: string;
  body?: string;
  subject?: string;
  [key: string]: unknown;
}

export interface NotificationTemplate {
  id: string;
  name: string;
  description: string | null;
  channels: Record<string, ChannelTemplate>;
  variables: string[];
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTemplateData {
  id: string;
  name: string;
  description?: string;
  channels: Record<string, ChannelTemplate>;
  variables?: string[];
  createdBy?: string;
}

export interface UpdateTemplateData {
  name?: string;
  description?: string;
  channels?: Record<string, ChannelTemplate>;
  variables?: string[];
}

export class TemplateService {
  async getTemplate(templateId: string): Promise<NotificationTemplate | null> {
    // Check cache first
    const cached = await cacheGet<NotificationTemplate>(`template:${templateId}`);
    if (cached) {
      return cached;
    }

    const result = await query<NotificationTemplate>(
      `SELECT * FROM notification_templates WHERE id = $1`,
      [templateId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const template = result.rows[0];

    // Cache for 10 minutes
    await cacheSet(`template:${templateId}`, template, 600);

    return template;
  }

  async getAllTemplates(): Promise<NotificationTemplate[]> {
    const result = await query<NotificationTemplate>(
      `SELECT * FROM notification_templates ORDER BY created_at DESC`
    );
    return result.rows;
  }

  async createTemplate(data: CreateTemplateData): Promise<NotificationTemplate> {
    const result = await query<NotificationTemplate>(
      `INSERT INTO notification_templates (id, name, description, channels, variables, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.id,
        data.name,
        data.description || null,
        JSON.stringify(data.channels),
        data.variables || [],
        data.createdBy || null,
      ]
    );
    return result.rows[0];
  }

  async updateTemplate(templateId: string, data: UpdateTemplateData): Promise<NotificationTemplate | undefined> {
    const result = await query<NotificationTemplate>(
      `UPDATE notification_templates
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           channels = COALESCE($4, channels),
           variables = COALESCE($5, variables),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        templateId,
        data.name,
        data.description,
        data.channels ? JSON.stringify(data.channels) : null,
        data.variables,
      ]
    );

    if (result.rows.length > 0) {
      // Invalidate cache
      await redis.del(`template:${templateId}`);
    }

    return result.rows[0];
  }

  async deleteTemplate(templateId: string): Promise<boolean> {
    const result = await query<{ id: string }>(
      `DELETE FROM notification_templates WHERE id = $1 RETURNING id`,
      [templateId]
    );

    if (result.rows.length > 0) {
      await redis.del(`template:${templateId}`);
    }

    return result.rows.length > 0;
  }

  renderTemplate(
    template: NotificationTemplate,
    channelType: string,
    data: Record<string, unknown>
  ): Record<string, unknown> {
    const channelTemplate = template.channels[channelType];
    if (!channelTemplate) {
      throw new Error(`Template does not support channel: ${channelType}`);
    }

    const rendered: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(channelTemplate)) {
      if (typeof value === 'string') {
        rendered[key] = this.interpolate(value, data);
      } else {
        rendered[key] = value;
      }
    }

    return rendered;
  }

  interpolate(template: string, data: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return data[key] !== undefined ? String(data[key]) : match;
    });
  }
}

export const templateService = new TemplateService();

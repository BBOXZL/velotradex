import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

/**
 * S6 AI 延迟重试队列表。
 * analyzeRaw 3 次耗尽后把 Discord 身份 + 原始消息落到这里，worker 每分钟重投
 * handleChannelMessage。去重键为 messageId（Discord 全局唯一），不依赖 60 秒
 * 内容哈希（见 G3）；执行层面的 action+symbol 去重由 worker 查 strategies 表完成。
 */
class AIDelayQueue extends Model {
  public id!: number;
  public messageId!: string;
  public channelId!: string;
  public rawMessage!: string | null;
  public routeIds!: string | null;
  public routeNames!: string | null;
  public originalTimestamp!: string | null;
  public retryCount!: number;
  public nextRetryAt!: Date;
  public status!: 'pending' | 'done' | 'exhausted';
  public lastError!: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

AIDelayQueue.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    messageId: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    channelId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rawMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    routeIds: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    routeNames: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    originalTimestamp: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    retryCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    nextRetryAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending',
    },
    lastError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'ai_delay_queue',
    indexes: [
      { fields: ['status', 'nextRetryAt'] },
      { fields: ['messageId'] },
    ],
  }
);

export default AIDelayQueue;

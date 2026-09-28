import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';
import { decryptSecret, encryptSecret, looksEncrypted } from '../utils/secretCipher';

class DiscordConfig extends Model {
  public id!: number;
  public tokenMode!: 'bot' | 'user';
  public token!: string | null;
  public channelIds!: string;
  public enabled!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

DiscordConfig.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tokenMode: { type: DataTypes.STRING, allowNull: false, defaultValue: 'bot' },
    token: { type: DataTypes.TEXT, allowNull: true },
    channelIds: { type: DataTypes.TEXT, allowNull: false, defaultValue: '[]' },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { sequelize, tableName: 'discord_configs' }
);

DiscordConfig.addHook('beforeSave', (instance: DiscordConfig) => {
  if (instance.token && !looksEncrypted(instance.token)) {
    instance.token = encryptSecret(instance.token);
  }
});

DiscordConfig.addHook('afterFind', (instancesOrInstance: DiscordConfig | DiscordConfig[] | null) => {
  const decryptOne = (instance: DiscordConfig) => {
    if (instance.token && looksEncrypted(instance.token)) {
      instance.token = decryptSecret(instance.token);
    }
  };
  if (Array.isArray(instancesOrInstance)) instancesOrInstance.forEach(decryptOne);
  else if (instancesOrInstance) decryptOne(instancesOrInstance);
});

export default DiscordConfig;

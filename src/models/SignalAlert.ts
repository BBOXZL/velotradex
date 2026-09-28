import { Model, DataTypes } from 'sequelize';
import { sequelize } from '../db';

/**
 * S8 拦截告警落库表（D2 默认：先落库 + 面板红点，零新依赖）。
 * MANUAL_INTERVENTION_BLOCKED / STRATEGY_REJECTED 发生时，除日志 + 审计外
 * 再写一行告警。面板用未读计数做红点；查看/确认后标已读。
 */
class SignalAlert extends Model {
  public id!: number;
  public strategyId!: number | null;
  public kind!: string; // 'MANUAL_INTERVENTION_BLOCKED' | 'STRATEGY_REJECTED' | ...
  public symbol!: string | null;
  public routeId!: number | null;
  public exchangeInstanceId!: string | null;
  public reason!: string | null;
  public isRead!: boolean;
  public readonly createdAt!: Date;
}

SignalAlert.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    strategyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    kind: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    symbol: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    routeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    exchangeInstanceId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    isRead: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'signal_alerts',
    updatedAt: false,
    indexes: [
      { fields: ['createdAt'] },
      { fields: ['isRead', 'createdAt'] },
      { fields: ['strategyId'] },
      { fields: ['kind'] },
    ],
  }
);

export default SignalAlert;

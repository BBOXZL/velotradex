'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('signal_alerts', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      strategyId: { type: Sequelize.INTEGER, allowNull: true },
      kind: { type: Sequelize.STRING, allowNull: false },
      symbol: { type: Sequelize.STRING, allowNull: true },
      routeId: { type: Sequelize.INTEGER, allowNull: true },
      exchangeInstanceId: { type: Sequelize.STRING, allowNull: true },
      reason: { type: Sequelize.TEXT, allowNull: true },
      isRead: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('signal_alerts', ['isRead', 'createdAt']);
    await queryInterface.addIndex('signal_alerts', ['strategyId']);
    await queryInterface.addIndex('signal_alerts', ['kind']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('signal_alerts');
  },
};

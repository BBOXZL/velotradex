'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ai_delay_queue', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      messageId: { type: Sequelize.STRING, allowNull: false, unique: true },
      channelId: { type: Sequelize.STRING, allowNull: false },
      rawMessage: { type: Sequelize.TEXT, allowNull: true },
      routeIds: { type: Sequelize.TEXT, allowNull: true },
      routeNames: { type: Sequelize.TEXT, allowNull: true },
      originalTimestamp: { type: Sequelize.STRING, allowNull: true },
      retryCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      nextRetryAt: { type: Sequelize.DATE, allowNull: false },
      status: { type: Sequelize.STRING, allowNull: false, defaultValue: 'pending' },
      lastError: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('ai_delay_queue', ['status', 'nextRetryAt']);
    await queryInterface.addIndex('ai_delay_queue', ['messageId']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ai_delay_queue');
  },
};

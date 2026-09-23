'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('discord_configs', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      tokenMode: { type: Sequelize.STRING, allowNull: false, defaultValue: 'bot' },
      token: { type: Sequelize.TEXT, allowNull: true },
      channelIds: { type: Sequelize.TEXT, allowNull: false, defaultValue: '[]' },
      enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('discord_configs');
  },
};

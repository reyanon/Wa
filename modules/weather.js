/**
 * @file modules/weather.js
 * @description Provides weather-related commands for the bot.
 * This module demonstrates how to structure commands, integrate with configuration,
 * handle API calls, and provide module-specific help.
 */

const axios = require('axios'); // For making HTTP requests to the weather API
const config = require('../config'); // To access bot configuration, especially API keys
const logger = require require('../core/logger'); // For logging module specific events

/**
 * Represents the WeatherModule.
 * This class handles all weather-related functionalities and commands.
 * It's designed to be loaded by the main ModuleLoader.
 */
class WeatherModule {
    /**
     * @param {object} bot - The main bot instance, passed by the ModuleLoader.
     * Provides access to bot-wide functionalities like sendMessage, config, etc.
     */
    constructor(bot) {
        this.bot = bot; // Store bot instance for later use in commands
        this.name = 'Weather Utilities'; // Display name of the module, used in .modules command
        this.version = '1.0.1'; // Version of this specific module
        // Define the commands this module provides.
        // Each command object must conform to the structure expected by MessageHandler:
        // { name: string, description: string, usage: string, category: string, execute: function }
        this.commands = [
            {
                name: 'weather',
                description: 'Get current weather information for a specified city.',
                usage: '.weather <city_name>',
                category: 'Utilities', // Category for dynamic menu display
                execute: this.getWeather.bind(this) // Bind 'this' to the module instance
            }
        ];
    }

    /**
     * Initializes the module. This method is called by the ModuleLoader after instantiation.
     * Use this for any setup that needs to happen once the module is loaded (e.g., database connections).
     * @returns {Promise<void>}
     */
    async init() {
        logger.info(`[WeatherModule] Initialized.`);
        // No specific async setup needed for this module, but it's good practice to have.
    }

    /**
     * Provides a detailed help text for this module.
     * This method will be called by the MenuModule's .help command if requested.
     * @param {string} prefix - The bot's command prefix (e.g., '.', '!').
     * @returns {string} The formatted help message.
     */
    getHelpText(prefix) {
        return `*☀️ Weather Module Help ☀️*\n\n` +
               `This module allows you to fetch current weather conditions for any city worldwide.\n\n` +
               `*Commands:*\n` +
               `  *${prefix}weather <city_name>*\n` +
               `    - Description: Retrieves real-time weather data for the given city.\n` +
               `    - Usage: Example: \`${prefix}weather London\` or \`${prefix}weather New York\`.` +
               `\n\n` +
               `_Powered by OpenWeatherMap. An API key is required in config.js._`;
    }

    /**
     * Executes the '.weather' command.
     * Fetches weather data from OpenWeatherMap API and sends it back to the user.
     * @param {object} msg - The original WhatsApp message object.
     * @param {string[]} params - An array of parameters passed with the command (e.g., ['London']).
     * @param {object} context - Context object containing bot, sender, participant, isGroup.
     */
    async getWeather(msg, params, context) {
        // Check if a city name was provided
        if (params.length === 0) {
            // If no city, send a usage message (can use getHelpText for this too)
            return context.bot.sendMessage(context.sender, {
                text: this.getHelpText(config.get('bot.prefix')) // Re-using getHelpText for usage info
            });
        }

        const city = params.join(' '); // Join all parameters to form the city name
        const apiKey = config.get('apis.weather'); // Get the API key from config

        // Check if the API key is configured
        if (!apiKey || apiKey === 'YOUR_WEATHER_API_KEY') { // Add a placeholder check
            logger.warn('[WeatherModule] Weather API key not configured.');
            return context.bot.sendMessage(context.sender, {
                text: '❌ Weather API key not configured. Please contact the bot owner or check `config.js`.'
            });
        }

        try {
            // Make the API request to OpenWeatherMap
            const response = await axios.get(
                `http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`
            );

            const data = response.data; // The data returned from the API
            // Format the weather information into a readable message
            const weatherText = `🌤️ *Weather in ${data.name}, ${data.sys.country}*\n\n` +
                                `🌡️ Temperature: ${data.main.temp}°C (feels like ${data.main.feels_like}°C)\n` +
                                `📝 Description: ${data.weather[0].description}\n` +
                                `💧 Humidity: ${data.main.humidity}%\n` +
                                `💨 Wind Speed: ${data.wind.speed} m/s\n` +
                                `👁️ Visibility: ${data.visibility / 1000} km\n` +
                                `🌅 Sunrise: ${new Date(data.sys.sunrise * 1000).toLocaleTimeString()}\n` +
                                `🌇 Sunset: ${new Date(data.sys.sunset * 1000).toLocaleTimeString()}`;

            // Send the formatted weather text back to the user
            await context.bot.sendMessage(context.sender, { text: weatherText });
            logger.info(`[WeatherModule] Sent weather for ${city} to ${context.sender}`);

        } catch (error) {
            let errorMessage = '❌ Failed to get weather information. An unexpected error occurred.';
            logger.error(`[WeatherModule] Error fetching weather for ${city}:`, error.message);
            
            // Handle specific API error responses
            if (error.response) {
                if (error.response.status === 404) {
                    errorMessage = `❌ City "${city}" not found. Please check the spelling.`;
                } else if (error.response.status === 401) {
                    errorMessage = '❌ Weather API key is invalid or unauthorized. Please check `config.js`.';
                } else {
                    errorMessage = `❌ API error (${error.response.status}): ${error.response.statusText || 'Unknown error'}`;
                }
            } else if (error.request) {
                errorMessage = '❌ No response received from weather API. Check network connection.';
            }

            await context.bot.sendMessage(context.sender, { text: errorMessage });
        }
    }
}

module.exports = WeatherModule;

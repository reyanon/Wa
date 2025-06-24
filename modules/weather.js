const axios = require('axios');
const config = require('../config');

class WeatherModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'Weather Utilities';
        this.version = '1.0.0';
        this.commands = [
            {
                name: 'weather',
                description: 'Get weather information for a city',
                usage: '.weather <city>',
                execute: this.getWeather.bind(this)
            }
        ];
    }

    async getWeather(msg, params, context) {
        if (params.length === 0) {
            return context.bot.sendMessage(context.sender, {
                text: '🌤️ *Weather Command*\n\nUsage: `.weather <city>`\nExample: `.weather London`'
            });
        }

        const city = params.join(' ');
        const apiKey = config.get('apis.weather');
        
        if (!apiKey) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ Weather API key not configured. Please contact the bot owner.'
            });
        }

        try {
            const response = await axios.get(
                `http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`
            );

            const data = response.data;
            const weatherText = `🌤️ *Weather in ${data.name}, ${data.sys.country}*\n\n` +
                              `🌡️ Temperature: ${data.main.temp}°C (feels like ${data.main.feels_like}°C)\n` +
                              `📝 Description: ${data.weather[0].description}\n` +
                              `💧 Humidity: ${data.main.humidity}%\n` +
                              `💨 Wind Speed: ${data.wind.speed} m/s\n` +
                              `👁️ Visibility: ${data.visibility / 1000} km\n` +
                              `🌅 Sunrise: ${new Date(data.sys.sunrise * 1000).toLocaleTimeString()}\n` +
                              `🌇 Sunset: ${new Date(data.sys.sunset * 1000).toLocaleTimeString()}`;

            await context.bot.sendMessage(context.sender, { text: weatherText });

        } catch (error) {
            let errorMessage = '❌ Failed to get weather information.';
            
            if (error.response?.status === 404) {
                errorMessage = `❌ City "${city}" not found. Please check the spelling.`;
            } else if (error.response?.status === 401) {
                errorMessage = '❌ Weather API key is invalid.';
            }

            await context.bot.sendMessage(context.sender, { text: errorMessage });
        }
    }
}

module.exports = WeatherModule;
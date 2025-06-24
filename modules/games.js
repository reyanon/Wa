const config = require('../config');

class GamesModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'Fun & Games';
        this.version = '1.0.0';
        this.activeGames = new Map();
        this.commands = [
            {
                name: 'rps',
                description: 'Play Rock Paper Scissors',
                usage: '.rps <rock|paper|scissors>',
                execute: this.playRPS.bind(this)
            },
            {
                name: 'dice',
                description: 'Roll a dice',
                usage: '.dice',
                execute: this.rollDice.bind(this)
            },
            {
                name: 'coin',
                description: 'Flip a coin',
                usage: '.coin',
                execute: this.flipCoin.bind(this)
            },
            {
                name: 'quote',
                description: 'Get a random quote',
                usage: '.quote',
                execute: this.getQuote.bind(this)
            },
            {
                name: 'joke',
                description: 'Get a random joke',
                usage: '.joke',
                execute: this.getJoke.bind(this)
            }
        ];
    }

    async playRPS(msg, params, context) {
        if (params.length === 0) {
            return context.bot.sendMessage(context.sender, {
                text: '🎮 *Rock Paper Scissors*\n\nUsage: `.rps <rock|paper|scissors>`'
            });
        }

        const userChoice = params[0].toLowerCase();
        const validChoices = ['rock', 'paper', 'scissors'];
        
        if (!validChoices.includes(userChoice)) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ Invalid choice! Use: rock, paper, or scissors'
            });
        }

        const botChoice = validChoices[Math.floor(Math.random() * validChoices.length)];
        let result = '';
        let emoji = '';

        if (userChoice === botChoice) {
            result = "It's a tie! 🤝";
            emoji = '😐';
        } else if (
            (userChoice === 'rock' && botChoice === 'scissors') ||
            (userChoice === 'paper' && botChoice === 'rock') ||
            (userChoice === 'scissors' && botChoice === 'paper')
        ) {
            result = 'You win! 🎉';
            emoji = '😄';
        } else {
            result = 'I win! 😎';
            emoji = '🤖';
        }

        const gameText = `🎮 *Rock Paper Scissors* ${emoji}\n\n` +
                        `👤 You: ${userChoice}\n` +
                        `🤖 Bot: ${botChoice}\n\n` +
                        `🏆 ${result}`;

        await context.bot.sendMessage(context.sender, { text: gameText });
    }

    async rollDice(msg, params, context) {
        const result = Math.floor(Math.random() * 6) + 1;
        const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
        
        const diceText = `🎲 *Dice Roll*\n\n` +
                        `${diceEmojis[result - 1]} You rolled: **${result}**`;

        await context.bot.sendMessage(context.sender, { text: diceText });
    }

    async flipCoin(msg, params, context) {
        const result = Math.random() < 0.5 ? 'heads' : 'tails';
        const coinEmoji = result === 'heads' ? '🪙' : '🪙';
        
        const coinText = `🪙 *Coin Flip*\n\n` +
                        `${coinEmoji} Result: **${result.toUpperCase()}**`;

        await context.bot.sendMessage(context.sender, { text: coinText });
    }

    async getQuote(msg, params, context) {
        const quotes = [
            "The best way to predict the future is to create it. - Peter Drucker",
            "Life is what happens to you while you're busy making other plans. - John Lennon",
            "The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt",
            "It is during our darkest moments that we must focus to see the light. - Aristotle",
            "The only impossible journey is the one you never begin. - Tony Robbins"
        ];

        const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
        
        await context.bot.sendMessage(context.sender, {
            text: `💭 *Quote of the Day*\n\n"${randomQuote}"`
        });
    }

    async getJoke(msg, params, context) {
        const jokes = [
            "Why don't scientists trust atoms? Because they make up everything!",
            "Why did the scarecrow win an award? He was outstanding in his field!",
            "Why don't eggs tell jokes? They'd crack each other up!",
            "What do you call a fake noodle? An impasta!",
            "Why did the math book look so sad? Because it had too many problems!"
        ];

        const randomJoke = jokes[Math.floor(Math.random() * jokes.length)];
        
        await context.bot.sendMessage(context.sender, {
            text: `😂 *Joke Time*\n\n${randomJoke}`
        });
    }
}

module.exports = GamesModule;

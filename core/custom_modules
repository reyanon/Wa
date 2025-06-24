# Custom Modules Directory

This directory is for user-uploaded custom modules. 

## Module Structure

Each custom module should follow this structure:

```javascript
class CustomModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'Your Module Name';
        this.version = '1.0.0';
        this.author = 'Your Name';
        this.description = 'Module description';
        
        this.commands = [
            {
                name: 'yourcommand',
                description: 'Command description',
                usage: '.yourcommand <params>',
                execute: this.yourMethod.bind(this)
            }
        ];
    }

    async init() {
        // Initialize your module
        console.log(`${this.name} initialized`);
    }

    async yourMethod(msg, params, context) {
        // Your command logic here
        await context.bot.sendMessage(context.sender, {
            text: 'Your response here'
        });
    }

    async destroy() {
        // Cleanup when module is unloaded
        console.log(`${this.name} destroyed`);
    }
}

module.exports = CustomModule;
```

## Context Object

The context object passed to command handlers contains:
- `bot`: The main bot instance
- `sender`: The chat JID where the message came from  
- `participant`: The user who sent the message
- `isGroup`: Boolean indicating if message is from a group

## Available Bot Methods

- `bot.sendMessage(jid, content)`: Send a message
- `bot.sock`: Direct access to WhatsApp socket (advanced usage)

## Examples

Check the core modules in the parent directory for examples of:
- Message handling
- API integration
- File operations
- Database operations
- Telegram bridge integration

## Installation

1. Place your `.js` file in this directory
2. Restart the bot or use the reload command
3. Your module will be automatically loaded

## Guidelines

- Follow the module structure exactly
- Handle errors gracefully
- Don't block the event loop
- Use async/await for asynchronous operations
- Test thoroughly before deployment

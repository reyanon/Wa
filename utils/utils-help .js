const helpRegistry = {};

function registerHelp(moduleName, helpObject) {
    helpRegistry[moduleName] = helpObject;
}

function getHelp() {
    return helpRegistry;
}

function getModuleHelp(module) {
    return helpRegistry[module] || null;
}

function getCommandHelp(cmd) {
    for (const [module, commands] of Object.entries(helpRegistry)) {
        for (const [command, desc] of Object.entries(commands)) {
            if (command.split(" ")[0] === cmd) {
                return { module, command, desc };
            }
        }
    }
    return null;
}

module.exports = {
    registerHelp,
    getHelp,
    getModuleHelp,
    getCommandHelp
};

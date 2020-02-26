const Discord = require('discord.js');
const bot = new Discord.Client();

const items_salut = ["Salut Trou Duc !",
               "Bienvenue à toi.",
               "Prend vite place.",
               "PTDR T KI ?",
              ];

const items_ouin = ["Tu as fini de OuinOuin !?",
               "Au lieu de OuinOuin tu devrais peut-être aller travailler",
               "Et voilà comment commencèrent les bébés, toujours à OuinOuin"
              ];

var prefix = ("^")

bot.on('ready', function() {
    bot.user.setGame("Command: ^help");
});

bot.login("NTA5MzA0MjM4MDc4NDI3MTM2.XlVFVg.Jc9oVKLAXdV582GH7q_TSXSnm2k");

bot.on('message', message => {
    // Pour les Aides c'est ICI
    if (message.content === prefix + "help"){
      message.channel.sendMessage("Liste des commandes:\n - ^help\n - ^info_serv");
    }
    if (message.content === prefix + "info_serv"){
      message.channel.sendMessage("Serveur de Jeu pour la LeVeLTeaM mon bro <3");
    }
    
    // Pour les OUIN OUIN c'est ICI
    if (message.content.includes("pas de badges")
    | message.content.includes("pas corrigé")
    | message.content.includes("pas de note") ){
      message.reply(random_salut(items_ouin));
    }
    // Pour les Salutations c'est ICI
    if (message.content === "Salut"
    | message.content === "salut"
    | message.content === "Bonjour"
    | message.content === "bonjour"
    | message.content === "Yo"
    | message.content === "yo"){
      message.reply(random_salut(items_salut));
    }
});

function random_salut(items_salut) {
  return items_salut[Math.floor(Math.random()*items_salut.length)];
}

function random_ouin(items_ouin) {
  return items_ouin[Math.floor(Math.random()*items_ouin.length)];
}

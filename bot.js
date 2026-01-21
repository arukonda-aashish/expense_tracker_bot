require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const fs = require('fs');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID);

const userStates = {};
const CATEGORIES = ['Home', 'Commute', 'Food', 'Subscriptions', 'Entertainment', 'Loans/Emi','Wellness', 'Investments', 'Insurances', 'Miscellaneous'];

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }
  const credPath = fs.existsSync('/etc/secrets/credentials.json') 
  ? '/etc/secrets/credentials.json' 
  : 'credentials.json';
const credentials = JSON.parse(fs.readFileSync(credPath));
  const jwtHeader = Buffer.from(JSON.stringify({alg: 'RS256', typ: 'JWT'})).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const jwtClaimSet = Buffer.from(JSON.stringify({iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now})).toString('base64url');
  const crypto = require('crypto');
  const signatureInput = jwtHeader + '.' + jwtClaimSet;
  const signature = crypto.createSign('RSA-SHA256').update(signatureInput).sign(credentials.private_key, 'base64url');
  const jwt = signatureInput + '.' + signature;
  const response = await fetch('https://oauth2.googleapis.com/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt});
  const data = await response.json();
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
  return accessToken;
}

function parseTransaction(text) {
  const patterns = [/(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)/i, /([\d,]+(?:\.\d{2})?)\s*(?:Rs\.?|INR|₹)/i];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return parseFloat(match[1].replace(/,/g, ''));
  }
  return null;
}

async function addTransaction(amount, category, notes = '',isRemove) {
  try {
    if(isRemove) amount=-amount;
    const token = await getAccessToken();
    const date = new Date().toISOString().split('T')[0];
    const time = new Date().toLocaleTimeString('en-IN', {hour: '2-digit', minute: '2-digit'});
    const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values/Transactions!A:E:append?valueInputOption=USER_ENTERED', {method: 'POST', headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, body: JSON.stringify({values: [[date, time, amount, category, notes]]})});
    return response.ok;
  } catch (error) {
    console.error('Error:', error);
    return false;
  }
}

async function getMonthlySummary() {
  try {
    const token = await getAccessToken();
    const response = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + '/values/Transactions!A:D', {headers: {'Authorization': 'Bearer ' + token}});
    const data = await response.json();
    const rows = data.values || [];
    const currentMonth = new Date().toISOString().slice(0, 7);
    const monthlyData = {};
    let total = 0;
    rows.slice(1).forEach(row => {
      if (row[0] && row[0].startsWith(currentMonth)) {
        const category = row[3] || 'Others';
        const amount = parseFloat(row[2]) || 0;
        monthlyData[category] = (monthlyData[category] || 0) + amount;
        total += amount;
      }
    });
    return {data: monthlyData, total};
  } catch (error) {
    return null;
  }
}

function getCategoryKeyboard() {
  const keyboard = [];
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    const row = [{text: (i + 1) + '. ' + CATEGORIES[i], callback_data: 'cat_' + i}];
    if (i + 1 < CATEGORIES.length) row.push({text: (i + 2) + '. ' + CATEGORIES[i + 1], callback_data: 'cat_' + (i + 1)});
    keyboard.push(row);
  }
  return {inline_keyboard: keyboard};
}

bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return bot.sendMessage(msg.chat.id, '❌ Unauthorized');
  bot.sendMessage(msg.chat.id, '👋 Welcome to Finance Tracker!\n\n1. Forward PhonePe SMS\n2. Select category\n3. Done!\n\nCommands:\n/add - Add expense\n/remove - Remove/Refund expense\n/summary - View monthly summary');
});

bot.onText(/\/add/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  userStates[msg.from.id] = {waitingFor: 'amount'};
  bot.sendMessage(msg.chat.id, '💰 Enter amount:');
});

bot.onText(/\/remove/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  userStates[msg.from.id] = {waitingFor: 'amount', isRemove: true};
  bot.sendMessage(msg.chat.id, '💸 Enter amount to remove:');
});


bot.onText(/\/summary/, async (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  const summary = await getMonthlySummary();
  if (!summary) return bot.sendMessage(msg.chat.id, '❌ Error');
  const monthName = new Date().toLocaleString('en-IN', {month: 'long', year: 'numeric'});
  let message = '📊 ' + monthName + '\n\n';
  Object.entries(summary.data).sort(([,a], [,b]) => b - a).forEach(([cat, amt]) => {
    message += cat + ': ₹' + amt.toFixed(2) + '\n';
  });
  message += '\n💵 Total: ₹' + summary.total.toFixed(2);
  bot.sendMessage(msg.chat.id, message);
});

bot.on('message', async (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID || !msg.text || msg.text.startsWith('/')) return;
  const userId = msg.from.id;
  
  if (userStates[userId]?.waitingFor === 'amount') {
    const amount = parseFloat(msg.text);
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(msg.chat.id, '❌ Invalid amount');
    
    userStates[userId] = {
      amount, 
      waitingFor: 'category', 
      isRemove: userStates[userId].isRemove || false
    };
    
    const emoji = userStates[userId].isRemove ? '💸' : '💰';
    return bot.sendMessage(msg.chat.id, emoji + ' ₹' + amount + '\nSelect category:', {reply_markup: getCategoryKeyboard()});
  }
  
  const amount = parseTransaction(msg.text);
  if (amount) {
    userStates[userId] = {amount, waitingFor: 'category'};
    bot.sendMessage(msg.chat.id, '✅ Detected: ₹' + amount + '\nSelect category:', {reply_markup: getCategoryKeyboard()});
  }
});

bot.on('callback_query', async (query) => {
  if (query.from.id !== ALLOWED_USER_ID) return;
  
  const userId = query.from.id;
  const data = query.data;
  
  if (data.startsWith('cat_')) {
    const categoryIndex = parseInt(data.split('_')[1]);
    const category = CATEGORIES[categoryIndex];
    
    if (userStates[userId]?.amount) {
      const {amount, isRemove} = userStates[userId];
      
      // If isRemove is true, save as negative amount
      const finalAmount = isRemove ? -Math.abs(amount) : amount;
      const notes = isRemove ? 'REFUND' : '';
      
      const success = await addTransaction(Math.abs(amount), category, notes, isRemove);
      
      if (success) {
        bot.answerCallbackQuery(query.id, {text: '✅ Saved!'});
        const emoji = isRemove ? '💸' : '💰';
        const action = isRemove ? 'Removed' : 'Added';
        bot.editMessageText(
          '✅ ' + action + '!\n' + emoji + ' ₹' + amount + '\n📂 ' + category, 
          {chat_id: query.message.chat.id, message_id: query.message.message_id}
        );
        delete userStates[userId];
      } else {
        bot.answerCallbackQuery(query.id, {text: '❌ Error'});
      }
    }
  }
});

console.log('🤖 Bot running...');
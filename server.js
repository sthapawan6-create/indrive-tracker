require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(express.json());
app.use(cors());

// Cache Control
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// Static Files
app.use(express.static(path.resolve(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI;

const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("✅ PAWAN GOLD डेटाबेस जडान सफल!");
    } catch (err) {
        console.error("❌ जडान त्रुटि:", err.message);
        setTimeout(connectDB, 5000);
    }
};
connectDB();

// --- Models ---
const BackupLogSchema = new mongoose.Schema({
    userId: String,
    status: String,
    timestamp: { type: Date, default: Date.now },
    fileKey: String,
    error: String
});
const BackupLog = mongoose.model('BackupLog', BackupLogSchema);

const AccountSchema = new mongoose.Schema({
    userId: String,
    name: { type: String, required: true },
    type: { type: String, enum: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'], required: true },
    group: String,
    openingBalance: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    phone: { type: String, default: "" },
    address: { type: String, default: "" },
    panVat: { type: String, default: "" }
});
const Account = mongoose.model('Account', AccountSchema);

const TransactionSchema = new mongoose.Schema({
    userId: String,
    date: String,
    description: String,
    type: { type: String, default: 'JOURNAL' },
    entries: [{
        account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
        debit: { type: Number, default: 0 },
        credit: { type: Number, default: 0 }
    }]
}, { timestamps: true });
const Transaction = mongoose.model('Transaction', TransactionSchema);

const SettingSchema = new mongoose.Schema({
    userId: String,
    lastClosedDate: { type: String, default: "" },
    accessPin: { type: String, default: "" }
});
const Setting = mongoose.model('Setting', SettingSchema);

const GoalSchema = new mongoose.Schema({
    userId: String,
    name: String,
    target: Number,
    deadline: String,
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
    createdAt: { type: Date, default: Date.now }
});
const Goal = mongoose.model('Goal', GoalSchema);

const BikeLogSchema = new mongoose.Schema({
    userId: String,
    type: { type: String, enum: ['Fuel', 'Service', 'Repair', 'Tax', 'Wash', 'Servicing'] },
    amount: Number,
    odometer: Number,
    description: String,
    date: { type: Date, default: Date.now }
});
const BikeLog = mongoose.model('BikeLog', BikeLogSchema);

const StockSchema = new mongoose.Schema({
    userId: String,
    symbol: String,
    qty: Number,
    buyPrice: Number,
    currentPrice: Number,
    updatedAt: { type: Date, default: Date.now }
});
const Stock = mongoose.model('Stock', StockSchema);

const CinemaShowSchema = new mongoose.Schema({
    userId: String,
    movieName: String,
    showTime: String,
    hall: String,
    tickets: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
    status: { type: String, default: 'Booking' },
    date: { type: Date, default: Date.now }
});
const CinemaShow = mongoose.model('CinemaShow', CinemaShowSchema);

const ElectricItemSchema = new mongoose.Schema({
    userId: String,
    category: String,
    name: String,
    specification: String,
    unit: String,
    rate: Number
});
const ElectricItem = mongoose.model('ElectricItem', ElectricItemSchema);

// --- APIs ---

const checkLock = async (userId, date) => {
    const s = await Setting.findOne({ userId });
    if (s && s.lastClosedDate && date <= s.lastClosedDate) return true;
    return false;
};

// १. खाताहरू (Accounts)
app.get('/api/accounts', async (req, res) => {
    try {
        const userId = req.query.userId;
        const accounts = await Account.find({ userId }).sort({ name: 1 });
        res.json(accounts);
    } catch (err) { res.status(500).json({ error: "त्रुटि भयो" }); }
});

app.post('/api/accounts', async (req, res) => {
    try {
        const account = new Account({ ...req.body });
        await account.save();
        res.status(200).json(account);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/accounts/:id', async (req, res) => {
    try {
        const acc = await Account.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(acc);
    } catch (err) { res.status(500).json({ error: "अपडेट असफल" }); }
});

app.delete('/api/accounts/:id', async (req, res) => {
    try {
        const hasTx = await Transaction.findOne({ "entries.account": req.params.id });
        if (hasTx) return res.status(400).json({ error: "यो खातामा कारोबार भइसकेको छ, मेटाउन मिल्दैन।" });
        await Account.findByIdAndDelete(req.params.id);
        res.json({ message: "सफल" });
    } catch (err) { res.status(500).json({ error: "मेटाउन सकिएन" }); }
});

// २. कारोबार (Transactions)
app.get('/api/transactions', async (req, res) => {
    try {
        const txs = await Transaction.find({ userId: req.query.userId }).populate('entries.account').sort({ createdAt: -1 });
        res.json(txs);
    } catch (err) { res.status(500).json({ error: "लोड असफल" }); }
});

app.post('/api/transactions', async (req, res) => {
    try {
        const { userId, date, description, entries, type } = req.body;
        if (await checkLock(userId, date)) return res.status(403).json({ error: "यो मितिको हिसाब क्लोज भइसकेको छ।" });
        const tx = new Transaction({ userId, date, description, entries, type: type || 'JOURNAL' });
        await tx.save();

        for (const entry of entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitInc = ['Asset', 'Expense'].includes(acc.type);
                acc.balance += isDebitInc ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                await acc.save();
            }
        }
        res.status(200).json(tx);
    } catch (err) { res.status(500).json({ error: "पोस्ट असफल" }); }
});

app.put('/api/transactions/:id', async (req, res) => {
    try {
        const { userId, date, description, entries, type } = req.body;
        const oldTx = await Transaction.findById(req.params.id);
        if (!oldTx) return res.status(404).json({ error: "भेटिएन" });

        // Reverse old balances
        for (const entry of oldTx.entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitInc = ['Asset', 'Expense'].includes(acc.type);
                acc.balance -= isDebitInc ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                await acc.save();
            }
        }

        // Apply new data
        oldTx.date = date;
        oldTx.description = description;
        oldTx.entries = entries;
        oldTx.type = type || 'JOURNAL';
        await oldTx.save();

        // Apply new balances
        for (const entry of entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitInc = ['Asset', 'Expense'].includes(acc.type);
                acc.balance += isDebitInc ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                await acc.save();
            }
        }
        res.json(oldTx);
    } catch (err) { res.status(500).json({ error: "अपडेट असफल" }); }
});

// ३. बाइक लग (Bike Log)
app.get('/api/bike', async (req, res) => {
    try {
        const logs = await BikeLog.find({ userId: req.query.userId }).sort({ date: -1 });
        res.json(logs);
    } catch (err) { res.status(500).json({ error: "Bike log load failed" }); }
});

app.post('/api/bike', async (req, res) => {
    try {
        const log = new BikeLog({ ...req.body });
        await log.save();
        res.json(log);
    } catch (err) { res.status(500).json({ error: "Bike log save failed" }); }
});

// ४. डिलिट र रिक्याल्कुलेट (Delete & Recalculate)
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).json({ error: "भेटिएन" });

        // ब्यालेन्स फिर्ता घटाउने/बढाउने
        for (const entry of tx.entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitInc = ['Asset', 'Expense'].includes(acc.type);
                acc.balance -= isDebitInc ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                await acc.save();
            }
        }
        await Transaction.findByIdAndDelete(req.params.id);
        res.json({ message: "सफल" });
    } catch (err) { res.status(500).json({ error: "त्रुटि भयो" }); }
});

app.post('/api/recalculate', async (req, res) => {
    const { userId } = req.body;
    try {
        const accounts = await Account.find({ userId });
        const transactions = await Transaction.find({ userId });

        for (const acc of accounts) {
            let newBalance = acc.openingBalance || 0;
            transactions.forEach(tx => {
                tx.entries.forEach(e => {
                    if (e.account.toString() === acc._id.toString()) {
                        const isDebitInc = ['Asset', 'Expense'].includes(acc.type);
                        newBalance += isDebitInc ? (e.debit - e.credit) : (e.credit - e.debit);
                    }
                });
            });
            acc.balance = newBalance;
            await acc.save();
        }
        res.json({ message: "सबै खाताको ब्यालेन्स पुन: गणना गरियो र मिलाइयो!" });
    } catch (err) { res.status(500).json({ error: "Recalculation failed" }); }
});

// --- Page Routes (AT THE END) ---

app.get('/login', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Fallback: If no route matches, serve index.html for SPA
app.get('*', (req, res) => {
    if (req.path.includes('.')) {
        return res.status(404).send("File Not Found");
    }
    res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n=========================================`);
    console.log(`🚀 PAWAN GOLD Server is LIVE!`);
    console.log(`URL: http://localhost:${PORT}`);
    console.log(`=========================================\n`);
});

process.on('uncaughtException', (err) => {
    console.error('There was an uncaught error', err);
});

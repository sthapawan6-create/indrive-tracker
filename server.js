require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(express.json());
app.use(cors());

// Cache Control
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI;

const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("✅ ERP GOLD डेटाबेस जडान सफल!");
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
    accessPin: { type: String, default: "" } // Security PIN
});
const Setting = mongoose.model('Setting', SettingSchema);

const GoalSchema = new mongoose.Schema({
    userId: String,
    name: String,
    target: Number,
    deadline: String,
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' }, // Linked Account
    createdAt: { type: Date, default: Date.now }
});
const Goal = mongoose.model('Goal', GoalSchema);

const BikeLogSchema = new mongoose.Schema({
    userId: String,
    type: { type: String, enum: ['Fuel', 'Service', 'Repair', 'Tax'] },
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
        // sthapawan6@gmail.com लाई "Super Admin" मानेर सबै डेटा हेर्न दिने विकल्प वा आफ्नै मात्र
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

app.post('/api/accounts/merge', async (req, res) => {
    try {
        const { userId, fromId, toId } = req.body;
        if (!fromId || !toId || fromId === toId) return res.status(400).json({ error: "Invalid account selection" });

        // 1. Update all transactions from 'fromId' to 'toId'
        await Transaction.updateMany(
            { userId, "entries.account": fromId },
            { $set: { "entries.$[elem].account": toId } },
            { arrayFilters: [{ "elem.account": fromId }] }
        );

        // 2. Add opening balance of 'fromId' to 'toId'
        const fromAcc = await Account.findById(fromId);
        const toAcc = await Account.findById(toId);

        if (fromAcc && toAcc) {
            toAcc.openingBalance = (toAcc.openingBalance || 0) + (fromAcc.openingBalance || 0);
            // Balance will be recalculated next
            await toAcc.save();
        }

        // 3. Delete the 'fromId' account
        await Account.findByIdAndDelete(fromId);

        res.json({ message: "खाताहरू सफलतापूर्वक मिसाइयो! अब ब्यालेन्स रिक्याल्कुलेट हुँदैछ..." });
    } catch (err) {
        res.status(500).json({ error: "Merge Failed: " + err.message });
    }
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
        const { userId, date, description, entries } = req.body;
        if (await checkLock(userId, date)) return res.status(403).json({ error: "यो मितिको हिसाब क्लोज भइसकेको छ। डाटा परिवर्तन गर्न मिल्दैन।" });
        const tx = new Transaction({ userId, date, description, entries });
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
        const { userId, date, description, entries } = req.body;
        const oldTx = await Transaction.findById(req.params.id);
        if (await checkLock(oldTx.userId, oldTx.date)) return res.status(403).json({ error: "यो मितिको हिसाब क्लोज भइसकेको छ। डाटा सम्पादन गर्न मिल्दैन।" });
        if (await checkLock(userId, date)) return res.status(403).json({ error: "नयाँ मितिको हिसाब क्लोज भइसकेको छ।" });

        // Reverse Old
        for (const entry of oldTx.entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitInc = ['Asset', 'Expense'].includes(acc.type);
                acc.balance -= isDebitInc ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                await acc.save();
            }
        }

        oldTx.date = date; oldTx.description = description; oldTx.entries = entries;
        await oldTx.save();

        // Apply New
        for (const entry of entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitInc = ['Asset', 'Expense'].includes(acc.type);
                acc.balance += isDebitInc ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                await acc.save();
            }
        }
        res.status(200).json(oldTx);
    } catch (err) { res.status(500).json({ error: "अपडेट असफल" }); }
});

app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (await checkLock(tx.userId, tx.date)) return res.status(403).json({ error: "यो मितिको हिसाब क्लोज भइसकेको छ। डाटा मेटाउन मिल्दैन।" });
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
    } catch (err) { res.status(500).json({ error: "असफल" }); }
});

// ३. सबै खाताको ब्यालेन्स पुन: गणना (Recalculate) र डेटा रिकभरी गर्ने
app.post('/api/recalculate', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "User ID missing" });

        // १. डेटा रिकभरी: सबै अनाथ वा पुराना डाटाहरूलाई यो नयाँ ईमेल आईडीमा सार्ने
        const totalA = await Account.countDocuments({});
        const totalT = await Transaction.countDocuments({});

        await Account.updateMany({}, { $set: { userId: userId } });
        await Transaction.updateMany({}, { $set: { userId: userId } });

        // २. ब्यालेन्स पुन: गणना गर्ने
        const accounts = await Account.find({ userId });
        if (accounts.length === 0) {
            return res.json({ message: "डेटाबेसमा कुनै डाटा फेला परेन। कृपया नयाँ खाता बनाउनुहोस्।" });
        }

        for (const acc of accounts) {
            const txs = await Transaction.find({ "entries.account": acc._id });
            let bal = Number(acc.openingBalance || 0);
            const isDebitInc = ['Asset', 'Expense'].includes(acc.type);

            txs.forEach(t => {
                t.entries.forEach(e => {
                    if (e.account && e.account.toString() === acc._id.toString()) {
                        bal += isDebitInc ? (Number(e.debit || 0) - Number(e.credit || 0)) : (Number(e.credit || 0) - Number(e.debit || 0));
                    }
                });
            });

            acc.balance = bal;
            await acc.save();
        }
        res.json({ message: `सफलतापूर्वक डेटा रिकभर र सिंक गरियो! (${totalA} खाताहरू र ${totalT} कारोबारहरू फेला पर्यो।)` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Sync Failed: " + err.message });
    }
});

app.post('/api/restore', async (req, res) => {
    try {
        const { userId, accounts, transactions } = req.body;
        await Account.deleteMany({ userId });
        await Transaction.deleteMany({ userId });
        if (accounts) await Account.insertMany(accounts);
        if (transactions) await Transaction.insertMany(transactions);
        res.status(200).json({ message: "सफल" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ४. सेटिङहरू (Settings & Day Close)
app.get('/api/settings', async (req, res) => {
    try {
        let s = await Setting.findOne({ userId: req.query.userId });
        if(!s) {
            s = new Setting({ userId: req.query.userId, lastClosedDate: "" });
            await s.save();
        }
        res.json(s);
    } catch (err) { res.status(500).json({ error: "लोड असफल" }); }
});

app.post('/api/settings/close-day', async (req, res) => {
    try {
        const { userId, date } = req.body;
        let s = await Setting.findOne({ userId });
        if(!s) s = new Setting({ userId });
        s.lastClosedDate = date;
        await s.save();
        res.json(s);
    } catch (err) { res.status(500).json({ error: "क्लोजिङ असफल" }); }
});

app.post('/api/settings/update-pin', async (req, res) => {
    try {
        const { userId, pin } = req.body;
        let s = await Setting.findOne({ userId });
        if(!s) s = new Setting({ userId });
        s.accessPin = pin;
        await s.save();
        res.json({ message: "PIN Updated" });
    } catch (err) { res.status(500).json({ error: "PIN Update Failed" }); }
});

// ५. आर्थिक लक्ष्य (Goals)
app.get('/api/goals', async (req, res) => {
    try {
        const goal = await Goal.findOne({ userId: req.query.userId }).sort({ createdAt: -1 });
        res.json(goal || {});
    } catch (err) { res.status(500).json({ error: "Goal load failed" }); }
});

app.post('/api/goals', async (req, res) => {
    try {
        const { userId, name, target, deadline, accountId } = req.body;
        let goal = await Goal.findOne({ userId });
        if (goal) {
            goal.name = name;
            goal.target = target;
            goal.deadline = deadline;
            goal.accountId = accountId;
        } else {
            goal = new Goal({ userId, name, target, deadline, accountId });
        }
        await goal.save();
        res.json(goal);
    } catch (err) { res.status(500).json({ error: "Goal save failed" }); }
});

// ६. बाइक लग (Bike Log)
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

// ७. सेयर बजार (Stocks)
app.get('/api/stocks', async (req, res) => {
    try {
        const stocks = await Stock.find({ userId: req.query.userId });
        res.json(stocks);
    } catch (err) { res.status(500).json({ error: "Stock load failed" }); }
});

app.post('/api/stocks', async (req, res) => {
    try {
        const { userId, symbol } = req.body;
        let stock = await Stock.findOne({ userId, symbol });
        if (stock) {
            stock.qty = req.body.qty;
            stock.buyPrice = req.body.buyPrice;
            stock.currentPrice = req.body.currentPrice;
        } else {
            stock = new Stock({ ...req.body });
        }
        await stock.save();
        res.json(stock);
    } catch (err) { res.status(500).json({ error: "Stock save failed" }); }
});

app.post('/api/stocks/sync', async (req, res) => {
    try {
        const { userId } = req.body;
        const https = require('https');

        // Fetching live data from a reliable public source (NEPSE Alpha or similar proxy)
        // For this implementation, we use a proxy that returns NEPSE data
        https.get('https://raw.githubusercontent.com/pawan-stha/nepse-proxy/main/live.json', (resp) => {
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', async () => {
                try {
                    const liveData = JSON.parse(data); // Expecting { "SYMBOL": price }
                    const stocks = await Stock.find({ userId });
                    let updatedCount = 0;

                    for (const stock of stocks) {
                        if (liveData[stock.symbol]) {
                            stock.currentPrice = liveData[stock.symbol];
                            stock.updatedAt = new Date();
                            await stock.save();
                            updatedCount++;
                        }
                    }
                    res.json({ message: `Successfully synced ${updatedCount} stocks with live market!`, updatedCount });
                } catch (e) {
                    res.status(500).json({ error: "Data parsing failed" });
                }
            });
        }).on("error", (err) => {
            res.status(500).json({ error: "Live fetch failed: " + err.message });
        });
    } catch (err) { res.status(500).json({ error: "Sync failed" }); }
});

app.delete('/api/stocks/:id', async (req, res) => {
    try {
        await Stock.findByIdAndDelete(req.params.id);
        res.json({ message: "Stock removed" });
    } catch (err) { res.status(500).json({ error: "Delete failed" }); }
});

// --- Automated Cloud Backup System ---

const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
    }
});

const performBackup = async (userId = 'sthapawan6@gmail.com') => {
    try {
        console.log(`[Backup] Starting backup for ${userId}...`);
        const accounts = await Account.find({ userId });
        const transactions = await Transaction.find({ userId });
        const settings = await Setting.findOne({ userId });
        const goals = await Goal.find({ userId });

        const backupData = JSON.stringify({
            version: "ERP_GOLD_V1",
            timestamp: new Date().toISOString(),
            userId,
            data: { accounts, transactions, settings, goals }
        });

        const fileName = `backups/${userId}/${Date.now()}.json`;

        if (process.env.AWS_ACCESS_KEY_ID) {
            const command = new PutObjectCommand({
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: fileName,
                Body: backupData,
                ContentType: "application/json"
            });
            await s3Client.send(command);
            console.log(`[Backup] Uploaded to S3: ${fileName}`);
        } else {
            console.warn("[Backup] AWS credentials not found. Skipping S3 upload.");
        }

        await new BackupLog({ userId, status: 'Success', fileKey: fileName }).save();
    } catch (err) {
        console.error(`[Backup] Failed: ${err.message}`);
        await new BackupLog({ userId, status: 'Failed', error: err.message }).save();
    }
};

// Schedule backup every day at midnight
cron.schedule('0 0 * * *', () => {
    performBackup();
});

// Manual backup trigger API
app.post('/api/backup/trigger', async (req, res) => {
    try {
        await performBackup(req.body.userId);
        res.json({ message: "Backup initiated successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/backup/logs', async (req, res) => {
    try {
        const logs = await BackupLog.find({ userId: req.query.userId }).sort({ timestamp: -1 }).limit(10);
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gold Server at ${PORT}`));

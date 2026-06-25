require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

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
const AccountSchema = new mongoose.Schema({
    userId: String,
    name: { type: String, required: true },
    type: { type: String, enum: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'], required: true },
    group: String,
    openingBalance: { type: Number, default: 0 },
    balance: { type: Number, default: 0 }
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
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

// --- APIs ---

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

// २. कारोबार (Transactions)
app.get('/api/transactions', async (req, res) => {
    try {
        const txs = await Transaction.find({ userId: req.query.userId }).populate('entries.account').sort({ date: -1 });
        res.json(txs);
    } catch (err) { res.status(500).json({ error: "लोड असफल" }); }
});

app.post('/api/transactions', async (req, res) => {
    try {
        const { userId, date, description, entries } = req.body;
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
        const { date, description, entries } = req.body;
        const oldTx = await Transaction.findById(req.params.id);

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
                const e = t.entries.find(en => en.account && en.account.toString() === acc._id.toString());
                if (e) {
                    bal += isDebitInc ? (Number(e.debit || 0) - Number(e.credit || 0)) : (Number(e.credit || 0) - Number(e.debit || 0));
                }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gold Server at ${PORT}`));

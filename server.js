require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// क्यास रोक्न यो कोड थपिएको छ
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB मा जडान सफल भयो!"))
    .catch(err => console.error("❌ MongoDB मा जडान हुन सकेन:", err));

// --- Models ---

const AccountSchema = new mongoose.Schema({
    userId: String,
    name: String,
    type: { type: String, enum: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] },
    group: String, // e.g., 'Sundry Debtors', 'Sundry Creditors', 'Bank Accounts'
    phone: String,
    address: String,
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
    }],
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

// --- APIs ---

// Create Account
app.post('/api/accounts', async (req, res) => {
    try {
        const account = new Account({ ...req.body });
        await account.save();
        res.status(200).json(account);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Accounts
app.get('/api/accounts', async (req, res) => {
    try {
        const accounts = await Account.find({ userId: req.query.userId });
        res.json(accounts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Post Journal Entry
app.post('/api/transactions', async (req, res) => {
    try {
        const { userId, date, description, entries } = req.body;

        // Basic validation: Total Debit must equal Total Credit
        const totalDebit = entries.reduce((sum, e) => sum + Number(e.debit), 0);
        const totalCredit = entries.reduce((sum, e) => sum + Number(e.credit), 0);

        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            return res.status(400).json({ error: "Debit and Credit must be equal!" });
        }

        const transaction = new Transaction({ userId, date, description, entries });
        await transaction.save();

        // Update Account Balances
        for (const entry of entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                // Asset/Expense: Dr increase, Cr decrease
                // Liability/Equity/Revenue: Cr increase, Dr decrease
                const isDebitIncrease = ['Asset', 'Expense'].includes(acc.type);
                const change = isDebitIncrease ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                acc.balance += change;
                await acc.save();
            }
        }

        res.status(200).json(transaction);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Transactions (Journal)
app.get('/api/transactions', async (req, res) => {
    try {
        const txs = await Transaction.find({ userId: req.query.userId })
            .populate('entries.account')
            .sort({ createdAt: -1 });
        res.json(txs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reports
app.get('/api/reports/trial-balance', async (req, res) => {
    try {
        const accounts = await Account.find({ userId: req.query.userId });
        res.json(accounts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Transaction (Edit)
app.put('/api/transactions/:id', async (req, res) => {
    try {
        const { date, description, entries } = req.body;
        const oldTx = await Transaction.findById(req.params.id);
        if (!oldTx) return res.status(404).json({ error: "Not found" });

        // १. पुरानो हिसाब उल्टाउने (Reverse old balances)
        for (const entry of oldTx.entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitIncrease = ['Asset', 'Expense'].includes(acc.type);
                const change = isDebitIncrease ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                acc.balance -= change;
                await acc.save();
            }
        }

        // २. नयाँ डेटा अपडेट गर्ने
        oldTx.date = date;
        oldTx.description = description;
        oldTx.entries = entries;
        await oldTx.save();

        // ३. नयाँ हिसाब लागू गर्ने (Apply new balances)
        for (const entry of entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitIncrease = ['Asset', 'Expense'].includes(acc.type);
                const change = isDebitIncrease ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                acc.balance += change;
                await acc.save();
            }
        }
        res.status(200).json(oldTx);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update Account
app.put('/api/accounts/:id', async (req, res) => {
    try {
        const acc = await Account.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(acc);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Account
app.delete('/api/accounts/:id', async (req, res) => {
    try {
        const txCount = await Transaction.countDocuments({ "entries.account": req.params.id });
        if (txCount > 0) return res.status(400).json({ error: "Cannot delete account with transactions" });
        await Account.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Transaction
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).json({ error: "Transaction not found" });

        // Reverse balances
        for (const entry of tx.entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitIncrease = ['Asset', 'Expense'].includes(acc.type);
                const change = isDebitIncrease ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                acc.balance -= change;
                await acc.save();
            }
        }

        await Transaction.findByIdAndDelete(req.params.id);
        res.json({ message: "Transaction deleted and balances reversed" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Restore Data
app.post('/api/restore', async (req, res) => {
    try {
        const { accounts, transactions } = req.body;
        if (!accounts || !transactions) return res.status(400).json({ error: "Invalid backup data" });

        const userIds = [...new Set(accounts.map(a => a.userId))];
        if (userIds.length > 0) {
            await Account.deleteMany({ userId: { $in: userIds } });
            await Transaction.deleteMany({ userId: { $in: userIds } });
            await Account.insertMany(accounts);
            await Transaction.insertMany(transactions);
        }
        res.status(200).json({ message: "Restore successful" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 सर्भर यहाँ चलिरहेको छ: http://localhost:${PORT}`));

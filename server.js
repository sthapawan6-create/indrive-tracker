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
        console.log("✅ PAWAN ELECTRONICS डेटाबेस जडान सफल!");
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
    type: { type: String, enum: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense', 'Receivable', 'Payable'], required: true },
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

const ProductSchema = new mongoose.Schema({
    userId: String,
    name: { type: String, required: true },
    category: { type: String, default: 'General' },
    brand: { type: String, default: 'None' },
    unit: { type: String, default: 'Pcs' },
    salePrice: { type: Number, default: 0 },
    purchasePrice: { type: Number, default: 0 },
    openingStock: { type: Number, default: 0 },
    currentStock: { type: Number, default: 0 }
});
const Product = mongoose.model('Product', ProductSchema);

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

const ServiceTicketSchema = new mongoose.Schema({
    userId: String,
    customerName: String,
    phone: String,
    itemName: String,
    problem: String,
    estimatedCost: { type: Number, default: 0 },
    status: { type: String, enum: ['Pending', 'Repairing', 'Ready', 'Delivered'], default: 'Pending' },
    receivedDate: { type: String }, // Storing as YYYY-MM-DD string for consistency with transactions
    deliveryDate: String,
    notes: String
}, { timestamps: true });
const ServiceTicket = mongoose.model('ServiceTicket', ServiceTicketSchema);

// --- APIs ---
app.get('/api/service-tickets', async (req, res) => {
    try {
        const { userId } = req.query;
        const query = userId ? { userId } : { userId: { $exists: false } };
        const tickets = await ServiceTicket.find(query).sort({ createdAt: -1 });
        res.json(tickets);
    } catch (err) { res.status(500).json({ error: "लोड असफल" }); }
});

app.post('/api/service-tickets', async (req, res) => {
    try {
        const ticket = new ServiceTicket({ ...req.body });
        await ticket.save();
        res.json(ticket);
    } catch (err) { res.status(500).json({ error: "बचत असफल" }); }
});

app.put('/api/service-tickets/:id', async (req, res) => {
    try {
        const { userId } = req.body;
        const ticket = await ServiceTicket.findOneAndUpdate({ _id: req.params.id, userId }, req.body, { new: true });
        if (!ticket) return res.status(404).json({ error: "टिकट भेटिएन" });
        res.json(ticket);
    } catch (err) { res.status(500).json({ error: "अपडेट असफल" }); }
});

app.delete('/api/service-tickets/:id', async (req, res) => {
    try {
        const { userId } = req.query;
        const ticket = await ServiceTicket.findOneAndDelete({ _id: req.params.id, userId });
        if (!ticket) return res.status(404).json({ error: "टिकट भेटिएन" });
        res.json({ message: "सफल" });
    } catch (err) { res.status(500).json({ error: "मेटाउन सकिएन" }); }
});

const checkLock = async (userId, date) => {
    const s = await Setting.findOne({ userId });
    if (s && s.lastClosedDate && date <= s.lastClosedDate) return true;
    return false;
};

// ३. सेटिङ्स (Settings)
app.get('/api/settings', async (req, res) => {
    try {
        let s = await Setting.findOne({ userId: req.query.userId });
        if (!s) s = new Setting({ userId: req.query.userId });
        res.json(s);
    } catch (err) { res.status(500).json({ error: "लोड असफल" }); }
});

app.post('/api/settings/close-day', async (req, res) => {
    try {
        const { userId, date } = req.body;
        let s = await Setting.findOne({ userId });
        if (!s) s = new Setting({ userId });
        s.lastClosedDate = date;
        await s.save();
        res.json(s);
    } catch (err) { res.status(500).json({ error: "क्लोज असफल" }); }
});

// १. खाताहरू (Accounts)
app.get('/api/accounts', async (req, res) => {
    try {
        const { userId } = req.query;
        // Strict filtering by userId. If no userId, show only legacy data.
        const query = userId ? { userId } : { userId: { $exists: false } };
        const accounts = await Account.find(query).sort({ name: 1 });
        res.json(accounts);
    } catch (err) { res.status(500).json({ error: "त्रुटि भयो" }); }
});

app.post('/api/accounts', async (req, res) => {
    try {
        console.log("Saving Account:", req.body);
        const account = new Account({ ...req.body });
        account.balance = account.openingBalance || 0;
        await account.save();
        res.status(200).json(account);
    } catch (err) {
        console.error("Account Save Error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/accounts/:id', async (req, res) => {
    try {
        const { name, type, openingBalance, phone, address, panVat, userId } = req.body;
        const acc = await Account.findOne({ _id: req.params.id, userId });
        if (!acc) return res.status(404).json({ error: "खाता भेटिएन वा पहुँच छैन" });

        acc.name = name || acc.name;
        acc.type = type || acc.type;
        acc.phone = phone !== undefined ? phone : acc.phone;
        acc.address = address !== undefined ? address : acc.address;
        acc.panVat = panVat !== undefined ? panVat : acc.panVat;

        if (openingBalance !== undefined) {
            acc.openingBalance = openingBalance;
        }

        // Recalculate balance for this account
        const transactions = await Transaction.find({ userId: acc.userId, "entries.account": acc._id });
        let newBalance = acc.openingBalance || 0;
        transactions.forEach(tx => {
            tx.entries.forEach(e => {
                if (e.account && e.account.toString() === acc._id.toString()) {
                    const isDebitInc = ['Asset', 'Expense', 'Receivable'].includes(acc.type);
                    newBalance += isDebitInc ? (e.debit - e.credit) : (e.credit - e.debit);
                }
            });
        });
        acc.balance = newBalance;

        await acc.save();
        res.json(acc);
    } catch (err) { res.status(500).json({ error: "अपडेट असफल" }); }
});

app.delete('/api/accounts/:id', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: "userId आवश्यक छ" });

        const acc = await Account.findOne({ _id: req.params.id, userId });
        if (!acc) return res.status(404).json({ error: "खाता भेटिएन" });

        const hasTx = await Transaction.findOne({ userId, "entries.account": req.params.id });
        if (hasTx) return res.status(400).json({ error: "यो खातामा कारोबार भइसकेको छ, मेटाउन मिल्दैन।" });
        await Account.findByIdAndDelete(req.params.id);
        res.json({ message: "सफल" });
    } catch (err) { res.status(500).json({ error: "मेटाउन सकिएन" }); }
});

// २. कारोबार (Transactions)
app.get('/api/transactions', async (req, res) => {
    try {
        const { userId } = req.query;
        const query = userId ? { userId } : { userId: { $exists: false } };
        const txs = await Transaction.find(query).populate('entries.account').sort({ createdAt: -1 });
        res.json(txs);
    } catch (err) { res.status(500).json({ error: "लोड असफल" }); }
});

// ५. सामानहरू (Products / Items)
app.get('/api/products', async (req, res) => {
    try {
        const { userId } = req.query;
        const query = userId ? { userId } : { userId: { $exists: false } };
        const products = await Product.find(query).sort({ name: 1 });
        res.json(products);
    } catch (err) { res.status(500).json({ error: "लोड असफल" }); }
});

app.post('/api/products', async (req, res) => {
    try {
        const product = new Product({ ...req.body });
        product.currentStock = product.openingStock || 0;
        await product.save();
        res.json(product);
    } catch (err) { res.status(500).json({ error: "बचत असफल" }); }
});

app.post('/api/transactions', async (req, res) => {
    try {
        const { userId, date, description, entries, type, items } = req.body;
        console.log("Attempting to save transaction:", { type, description, date });

        if (!date) return res.status(400).json({ error: "कृपया मिति छान्नुहोस्।" });
        if (!entries || entries.length === 0) return res.status(400).json({ error: "इन्ट्री विवरण खाली छ।" });

        // Use default admin if userId is missing
        const finalUserId = userId || 'pawan-electronics-admin';

        try {
            if (await checkLock(finalUserId, date)) {
                return res.status(403).json({ error: "यो मितिको हिसाब क्लोज भइसकेको छ।" });
            }
        } catch (lockErr) {
            console.warn("Lock check skipped:", lockErr.message);
        }

        const tx = new Transaction({
            userId: finalUserId,
            date,
            description,
            entries,
            type: type || 'JOURNAL'
        });

        await tx.save();
        console.log("Transaction saved:", tx._id);

        // Update Account Balances
        for (const entry of entries) {
            const acc = await Account.findOne({ _id: entry.account, userId: finalUserId });
            if (acc) {
                const isDebitInc = ['Asset', 'Expense', 'Receivable'].includes(acc.type);
                acc.balance += isDebitInc ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                await acc.save();
            }
        }

        // --- Update Stock ---
        if (items && items.length > 0) {
            for (const item of items) {
                const pId = item.productId || item.product;
                if (pId) {
                    const prod = await Product.findOne({ _id: pId, userId: finalUserId });
                    if (prod) {
                        const qty = Number(item.qty || item.quantity);
                        if (type === 'SALES' || type === 'PURCHASE_RETURN') prod.currentStock -= qty;
                        if (type === 'PURCHASE' || type === 'SALES_RETURN') prod.currentStock += qty;
                        await prod.save();
                    }
                }
            }
        }

        res.status(200).json(tx);
    } catch (err) {
        console.error("Transaction Save Error:", err);
        res.status(500).json({ error: "सेभ असफल: " + err.message });
    }
});

app.put('/api/transactions/:id', async (req, res) => {
    try {
        const { userId, date, description, entries, type } = req.body;
        if (await checkLock(userId, date)) return res.status(403).json({ error: "यो मितिको हिसाब क्लोज भइसकेको छ।" });

        const oldTx = await Transaction.findById(req.params.id);
        if (!oldTx) return res.status(404).json({ error: "भेटिएन" });
        if (await checkLock(userId, oldTx.date)) return res.status(403).json({ error: "पुरानो मितिको हिसाब क्लोज भइसकेको छ।" });

        // Reverse old balances
        for (const entry of oldTx.entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitInc = ['Asset', 'Expense', 'Receivable'].includes(acc.type);
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
                const isDebitInc = ['Asset', 'Expense', 'Receivable'].includes(acc.type);
                acc.balance += isDebitInc ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                await acc.save();
            }
        }
        res.json(oldTx);
    } catch (err) { res.status(500).json({ error: "अपडेट असफल" }); }
});

// ४. आर्थिक वर्ष समापन (Fiscal Year Closing)
app.post('/api/fiscal-year-close', async (req, res) => {
    try {
        const { userId, date, equityAccountId } = req.body;
        if (!equityAccountId) return res.status(400).json({ error: "Equity (Capital) खाता छानिएको छैन।" });

        const accounts = await Account.find({ userId });
        const revenueAccounts = accounts.filter(a => a.type === 'Revenue');
        const expenseAccounts = accounts.filter(a => a.type === 'Expense');

        let totalRevenue = 0;
        let totalExpense = 0;
        const entries = [];

        // Revenue zero out
        for (const acc of revenueAccounts) {
            if (acc.balance !== 0) {
                totalRevenue += acc.balance;
                entries.push({ account: acc._id, debit: acc.balance, credit: 0 }); // Debit to zero out Revenue
                acc.balance = 0;
                await acc.save();
            }
        }

        // Expense zero out
        for (const acc of expenseAccounts) {
            if (acc.balance !== 0) {
                totalExpense += acc.balance;
                entries.push({ account: acc._id, debit: 0, credit: acc.balance }); // Credit to zero out Expense
                acc.balance = 0;
                await acc.save();
            }
        }

        const netProfit = totalRevenue - totalExpense;

        if (entries.length === 0) return res.status(400).json({ error: "शून्य बनाउनुपर्ने कुनै हिसाब भेटिएन।" });

        // Equity account update
        const equityAcc = await Account.findById(equityAccountId);
        if (!equityAcc) return res.status(404).json({ error: "Equity खाता भेटिएन।" });

        equityAcc.balance += netProfit;
        await equityAcc.save();

        // Counter entry for Equity
        entries.push({
            account: equityAcc._id,
            debit: netProfit < 0 ? Math.abs(netProfit) : 0,
            credit: netProfit > 0 ? netProfit : 0
        });

        // Save Closing Transaction
        const closingTx = new Transaction({
            userId,
            date,
            description: `Fiscal Year Closing (${date}) - Net Profit: ${netProfit}`,
            type: 'CLOSING',
            entries
        });
        await closingTx.save();

        // Update settings
        let s = await Setting.findOne({ userId });
        if (!s) s = new Setting({ userId });
        s.lastClosedDate = date;
        await s.save();

        res.json({ message: "आर्थिक वर्ष सफलतापूर्वक समापन गरियो!", netProfit, transactionId: closingTx._id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "समापन प्रक्रिया असफल भयो।" });
    }
});

// ४. डिलिट र रिक्याल्कुलेट (Delete & Recalculate)
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).json({ error: "भेटिएन" });
        if (await checkLock(tx.userId, tx.date)) return res.status(403).json({ error: "यो मितिको हिसाब क्लोज भइसकेको छ।" });

        // ब्यालेन्स फिर्ता घटाउने/बढाउने
        for (const entry of tx.entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitInc = ['Asset', 'Expense', 'Receivable'].includes(acc.type);
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
                    if (e.account && e.account.toString() === acc._id.toString()) {
                        const isDebitInc = ['Asset', 'Expense', 'Receivable'].includes(acc.type);
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
    console.log(`🚀 PAWAN ELECTRONICS Server is LIVE!`);
    console.log(`URL: http://localhost:${PORT}`);
    console.log(`=========================================\n`);
});

process.on('uncaughtException', (err) => {
    console.error('There was an uncaught error', err);
});

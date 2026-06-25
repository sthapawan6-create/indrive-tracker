require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// सुरक्षा र क्यास नियन्त्रण (ब्राउजरमा पुराना फाइलहरू नबसुन भनेर)
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// हरेक अनुरोध (Request) लाई नेपालीमा ट्र्याक गर्ने मिडिलवेयर
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleTimeString()}] 🚀 अनुरोध प्राप्त: ${req.method} ${req.url}`);
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const MONGO_URI = process.env.MONGO_URI;

// डेटाबेस जडान (Retry logic सहित ताकि कनेक्सन टुट्दा फेरि जोडिन सकोस्)
const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("✅ ERP GOLD डेटाबेससँग जडान सफल भयो! (तपाईंको डेटा पूर्ण सुरक्षित छ)");
    } catch (err) {
        console.error("❌ डेटाबेस जडानमा त्रुटि:", err.message);
        setTimeout(connectDB, 5000); // जडान असफल भए ५ सेकेन्डमा फेरि प्रयास गर्ने
    }
};
connectDB();

// --- डेटा मोडेलहरू (एकाउन्टिङ संरचना) ---

const AccountSchema = new mongoose.Schema({
    userId: String,
    name: { type: String, required: true },
    type: { type: String, enum: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'], required: true },
    group: String,
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

// --- मुख्य API सेवाहरू (Extreme Gold Suite) ---

// १. नयाँ खाता (Ledger) थप्ने
app.post('/api/accounts', async (req, res) => {
    try {
        const account = new Account({ ...req.body });
        await account.save();
        console.log(`✨ नयाँ खाता सिर्जना: ${account.name}`);
        res.status(200).json(account);
    } catch (err) {
        res.status(500).json({ error: "खाता खोल्न सकिएन: " + err.message });
    }
});

// २. सबै खाताहरू तान्ने
app.get('/api/accounts', async (req, res) => {
    try {
        const accounts = await Account.find({ userId: req.query.userId }).sort({ name: 1 });
        res.json(accounts);
    } catch (err) {
        res.status(500).json({ error: "डेटा तान्न सकिएन।" });
    }
});

// ३. भौचर प्रविष्टि (Double Entry सँगै ब्यालेन्स अपडेट)
app.post('/api/transactions', async (req, res) => {
    try {
        const { userId, date, description, entries } = req.body;

        const totalDebit = entries.reduce((sum, e) => sum + Number(e.debit || 0), 0);
        const totalCredit = entries.reduce((sum, e) => sum + Number(e.credit || 0), 0);

        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            return res.status(400).json({ error: "हिसाब मिलेन! डेबिट र क्रेडिट सधैं बराबर हुनुपर्छ।" });
        }

        const transaction = new Transaction({ userId, date, description, entries });
        await transaction.save();

        // सम्बन्धित खाताहरूको ब्यालेन्स तत्काल अपडेट गर्ने
        for (const entry of entries) {
            const acc = await Account.findById(entry.account);
            if (acc) {
                const isDebitIncrease = ['Asset', 'Expense'].includes(acc.type);
                const change = isDebitIncrease ? (entry.debit - entry.credit) : (entry.credit - entry.debit);
                acc.balance += change;
                await acc.save();
            }
        }

        console.log(`✅ भौचर सफलतापूर्वक सेभ गरियो: ${description}`);
        res.status(200).json(transaction);
    } catch (err) {
        res.status(500).json({ error: "भौचर प्रविष्टिमा समस्या आयो।" });
    }
});

// ४. कारोबार इतिहास हेर्ने
app.get('/api/transactions', async (req, res) => {
    try {
        const txs = await Transaction.find({ userId: req.query.userId })
            .populate('entries.account')
            .sort({ date: -1, createdAt: -1 });
        res.json(txs);
    } catch (err) {
        res.status(500).json({ error: "कारोबार इतिहास लोड गर्न सकिएन।" });
    }
});

// ५. भौचर मेटाउने (र हिसाब उल्ट्याउने)
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).json({ error: "कारोबार फेला परेन।" });

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
        console.log(`🗑️ भौचर हटाइयो र ब्यालेन्स सच्याइयो।`);
        res.json({ message: "भौचर सफलतापूर्वक हटाइयो।" });
    } catch (err) {
        res.status(500).json({ error: "हटाउन असफल भयो।" });
    }
});

// ५.१ खाता (Account) मेटाउने API (सुरक्षा जाँच सहित)
app.delete('/api/accounts/:id', async (req, res) => {
    try {
        const accId = req.params.id;
        // के यो खातामा कुनै कारोबार छ?
        const hasTx = await Transaction.findOne({ "entries.account": accId });
        if (hasTx) {
            return res.status(400).json({ error: "यो खाता मेटाउन मिल्दैन! यसमा पहिले नै कारोबार भइसकेको छ।" });
        }
        await Account.findByIdAndDelete(accId);
        console.log(`🗑️ खाता हटाइयो: ${accId}`);
        res.json({ message: "खाता सफलतापूर्वक हटाइयो।" });
    } catch (err) {
        res.status(500).json({ error: "खाता हटाउन सकिएन।" });
    }
});

// ६. डेटा रिस्टोर (Backup Recovery)
app.post('/api/restore', async (req, res) => {
    try {
        const { userId, accounts, transactions } = req.body;
        if (!userId) return res.status(400).json({ error: "यूजर आईडी आवश्यक छ।" });

        // पुरानो डेटा मेटाएर नयाँ डेटा राख्ने
        await Account.deleteMany({ userId });
        await Transaction.deleteMany({ userId });

        if (accounts && accounts.length > 0) await Account.insertMany(accounts);
        if (transactions && transactions.length > 0) await Transaction.insertMany(transactions);

        console.log(`♻️ प्रयोगकर्ता ${userId} को डेटा रिस्टोर सफल भयो।`);
        res.status(200).json({ message: "ब्याकअप रिस्टोर सफल भयो!" });
    } catch (err) {
        res.status(500).json({ error: "रिस्टोरमा त्रुटि: " + err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    ===========================================
    🌟 ERP GOLD EXTREME - नेपाली संस्करण 🌟
    🚀 सर्भर सुचारु भयो: http://localhost:${PORT}
    📅 मिति: ${new Date().toLocaleDateString()}
    💎 तपाईंको डेटा पूर्ण रूपमा सुरक्षित छ!
    ===========================================
    `);
});

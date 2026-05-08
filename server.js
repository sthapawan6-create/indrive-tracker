require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// मुख्य पेज देखाउनको लागि (Root Route)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB मा जडान सफल भयो!"))
    .catch(err => console.error("❌ MongoDB मा जडान हुन सकेन:", err));

const RecordSchema = new mongoose.Schema({
    userId: String,
    income: Number,
    fuel: Number,
    food: Number,
    note: String,
    date: { type: String, default: () => new Date().toLocaleDateString('ne-NP') },
    createdAt: { type: Date, default: Date.now }
});

const Record = mongoose.model('Record', RecordSchema);

app.post('/api/add', async (req, res) => {
    try {
        console.log("Saving Data for user:", req.body.userId);
        const newRecord = new Record(req.body);
        await newRecord.save();
        res.status(200).json({ message: "Successfully Saved" });
    } catch (err) {
        console.error("Save Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/history', async (req, res) => {
    try {
        const history = await Record.find({ userId: req.query.userId }).sort({ createdAt: -1 });
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/delete/:id', async (req, res) => {
    try {
        await Record.findByIdAndDelete(req.params.id);
        res.status(200).json({ message: "Deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 सर्भर यहाँ चलिरहेको छ: http://localhost:${PORT}`));

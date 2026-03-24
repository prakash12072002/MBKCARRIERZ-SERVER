const express = require('express');
const router = express.Router();
const City = require('../models/City');
const Trainer = require('../models/Trainer');
const { authenticate } = require('../middleware/auth');

const User = require('../models/User'); // Import User model

const escapeRegex = (value = '') =>
    String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildCityMatchQuery = (city) => ({
    $or: [
        { cityId: city._id },
        { city: new RegExp(`^${escapeRegex(city.name)}$`, 'i') }
    ]
});

// Get all cities with trainer counts
router.get('/', async (req, res) => {
    try {
        const cities = await City.find().sort({ name: 1 });

        const citiesWithCounts = await Promise.all(cities.map(async (city) => {
            const count = await Trainer.countDocuments(buildCityMatchQuery(city));
            return {
                ...city.toObject(),
                trainerCount: count
            };
        }));

        res.json({ success: true, cities: citiesWithCounts });
    } catch (error) {
        console.error('Error fetching cities:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Add city
router.post('/', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'SuperAdmin') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const { name } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'City name required' });

        const existing = await City.findOne({ name });
        if (existing) return res.status(400).json({ success: false, message: 'City already exists' });

        const city = await City.create({ name });
        res.status(201).json({ success: true, city });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Update city and propagate changes
router.put('/:id', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'SuperAdmin') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const { name } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'City name required' });

        const city = await City.findById(req.params.id);
        if (!city) return res.status(404).json({ success: false, message: 'City not found' });

        const oldName = city.name;
        const trainerMatchQuery = buildCityMatchQuery(city);
        const affectedTrainers = await Trainer.find(trainerMatchQuery).select('userId');

        // Check if new name already exists (and isn't the same city)
        const existing = await City.findOne({ name });
        if (existing && existing._id.toString() !== req.params.id) {
            return res.status(400).json({ success: false, message: 'City name already exists' });
        }

        // Update City
        city.name = name;
        await city.save();

        await Trainer.updateMany(
            trainerMatchQuery,
            { $set: { city: name, cityId: city._id } }
        );

        const affectedTrainerUserIds = affectedTrainers
            .map((trainer) => trainer.userId)
            .filter(Boolean);

        await User.updateMany(
            {
                role: 'Trainer',
                $or: [
                    { _id: { $in: affectedTrainerUserIds } },
                    { city: new RegExp(`^${escapeRegex(oldName)}$`, 'i') }
                ]
            },
            { $set: { city: name } }
        );

        const trainerCount = await Trainer.countDocuments(buildCityMatchQuery(city));

        res.json({
            success: true,
            message: 'City updated and propagated to trainers',
            city: { ...city.toObject(), trainerCount }
        });

    } catch (error) {
        console.error('Error updating city:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Delete city
router.delete('/:id', authenticate, async (req, res) => {
    try {
        if (req.user.role !== 'SuperAdmin') {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }
        await City.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'City deleted' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;

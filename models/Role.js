const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    permissions: [{
        type: String,
        trim: true
    }],
    description: {
        type: String,
        default: ''
    }
}, {
    timestamps: true
});

const Role = mongoose.model('Role', roleSchema);

module.exports = Role;

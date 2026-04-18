const { parseTrainerDirectoryQuery } = require("./trainers.schema");
const { listTrainerDirectory } = require("./trainers.service");

const listTrainersController = async (req, res) => {
  try {
    const query = parseTrainerDirectoryQuery(req.query);
    const payload = await listTrainerDirectory({
      query,
      user: req.user,
    });

    return res.json(payload);
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    return res.status(statusCode).json({
      success: false,
      message: error?.message || "Failed to fetch trainers",
    });
  }
};

module.exports = {
  listTrainersController,
};


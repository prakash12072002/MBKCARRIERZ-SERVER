import { serverClient } from "../services/streamService.mjs";

export const createGroup = async (req, res) => {
  try {
    const { name, members } = req.body;

    const channel = serverClient.channel("team", {
      name,
      members,
      created_by_id: req.user.id,
    });

    await channel.create();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

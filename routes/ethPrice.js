const express = require("express");
const router = express.Router();
const axios = require("axios");
const EthPrice = require("../models/EthPrice");

// GET latest ETH price (from DB)
router.get("/eth", async (req, res) => {
  try {
    const priceDoc = await EthPrice.findOne({});
    if (!priceDoc) {
      return res.status(404).json({ error: "ETH price not available" });
    }

    res.json({
      usd: priceDoc.usd,
      lastUpdated: priceDoc.lastUpdated,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Alias route for compatibility with Escrowintegration.js
router.get("/", async (req, res) => {
  try {
    const priceDoc = await EthPrice.findOne({});
    if (!priceDoc) {
      return res.status(404).json({ error: "ETH price not available" });
    }

    res.json({
      usd: priceDoc.usd,
      lastUpdated: priceDoc.lastUpdated,
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Internal use: Update ETH price from CoinGecko
const updateEthPrice = async () => {
  try {
    const response = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
    );
    const ethPrice = response.data.ethereum.usd;

    await EthPrice.findOneAndUpdate(
      {},
      { usd: ethPrice, lastUpdated: new Date() },
      { upsert: true, new: true }
    );

    console.log("ETH price updated:", ethPrice);
  } catch (err) {
    console.error("Error updating ETH price:", err.message);
  }
};

// Export the update function so it can be called from your main server
module.exports = { router, updateEthPrice };

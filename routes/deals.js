'use strict';
const router = require('express').Router();
// TODO: Codex — implement deals routes per MVP brief
router.get('/', (_req, res) => res.json({ deals: [], message: 'Deals route — coming soon' }));
module.exports = router;

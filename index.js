require("dotenv").config();

const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require('express');
const cors = require('cors')
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
// const dotenv = require('dotenv');
// dotenv.config()

const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT;

app.use(cors())
app.use(express.json())

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});




async function run() {
    try {
        await client.connect();
        const db = client.db("arthub");
        const artCollection = db.collection("artworks")
        const usersCollection = db.collection("user");
        const purchasesCollection = db.collection("purchases");

        app.post("/artworks", async (req, res) => {
            const artData = req.body;
            const result = await artCollection.insertOne(artData);
            res.json(result)
        })

        app.get("/artworks", async (req, res) => {
            const result = await artCollection.find().toArray();
            res.send(result);
        });

        app.get("/artworks/:id", async (req, res) => {
            const { id } = req.params;

            const artwork = await artCollection.findOne({
                _id: new ObjectId(id),
            });

            res.send(artwork);
        });

        app.delete("/artworks/:id", async (req, res) => {
            const id = req.params.id;

            const result = await artCollection.deleteOne({
                _id: new ObjectId(id),
            });

            res.send(result);
        });

        app.put("/artworks/:id", async (req, res) => {
            const id = req.params.id;
            const updatedArtwork = req.body;

            const result = await artCollection.updateOne(
                { _id: new ObjectId(id) },
                {
                    $set: updatedArtwork,
                }
            );

            res.send(result);
        });

        app.get("/artworks/artist/:email", async (req, res) => {
            const email = req.params.email;

            const result = await artCollection
                .find({ artistEmail: email })
                .sort({ createdAt: -1 })
                .toArray();

            res.send(result);
        });


        app.get("/user/:email", async (req, res) => {
            try {
                const email = req.params.email;

                const user = await usersCollection.findOne({ email });

                if (!user) {
                    return res.status(404).json({
                        message: "User not found",
                    });
                }

                res.json(user);
            } catch (error) {
                console.error(error);
                res.status(500).json({
                    message: "Failed to fetch user",
                });
            }
        });

        app.patch(
            "/user/subscription/:email",
            async (req, res) => {
                const email = req.params.email;

                const { subscriptionTier } = req.body;

                const result =
                    await usersCollection.updateOne(
                        { email },
                        {
                            $set: {
                                subscriptionTier,
                            },
                        }
                    );

                res.send(result);
            }
        );

        app.post("/create-checkout-session", async (req, res) => {
            try {
                const { artworkId, buyerEmail } = req.body;

                const user = await usersCollection.findOne({
                    email: buyerEmail,
                });

                const artwork = await artCollection.findOne({
                    _id: new ObjectId(artworkId),
                });

                if (!artwork) {
                    return res.status(404).json({
                        message: "Artwork not found",
                    });
                }

                const tier = (user?.subscriptionTier || "free").toLowerCase();

                let purchaseLimit = 3;

                if (tier === "pro") purchaseLimit = 9;

                if (tier === "premium") purchaseLimit = Infinity;

                const purchasedCount =
                    await purchasesCollection.countDocuments({
                        buyerEmail,
                        paymentStatus: "paid",
                    });

                if (purchasedCount >= purchaseLimit) {
                    return res.status(403).json({
                        message:
                            "Purchase limit reached. Please upgrade your subscription.",
                    });
                }

                const stripeSession =
                    await stripe.checkout.sessions.create({
                        payment_method_types: ["card"],

                        mode: "payment",

                        customer_email: buyerEmail,

                        line_items: [
                            {
                                price_data: {
                                    currency: "usd",
                                    product_data: {
                                        name: artwork.title,
                                        images: [artwork.image],
                                    },
                                    unit_amount: Math.round(
                                        artwork.price * 100
                                    ),
                                },
                                quantity: 1,
                            },
                        ],

                        metadata: {
                            artworkId,
                            buyerEmail,
                        },

                        success_url: `${process.env.CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,

                        cancel_url: `${process.env.CLIENT_URL}/artwork/${artworkId}`,
                    });

                res.json({
                    checkoutUrl: stripeSession.url,
                });

            } catch (err) {
                console.log(err);

                res.status(500).json({
                    message: err.message,
                });
            }
        });



        app.post("/verify-payment", async (req, res) => {

            console.log("VERIFY PAYMENT HIT");

            const { sessionId } = req.body;

            const session =
                await stripe.checkout.sessions.retrieve(sessionId);

            if (session.payment_status !== "paid") {
                return res.status(400).send({
                    message: "Payment not completed",
                });
            }

            const artworkId = session.metadata.artworkId;
            const buyerEmail = session.metadata.buyerEmail;

            const alreadyPurchased = await purchasesCollection.findOne({
                artworkId,
                buyerEmail,
            });

            if (!alreadyPurchased) {

                await purchasesCollection.insertOne({
                    artworkId,
                    artworkName: artwork.title,
                    artist: artwork.artistName,
                    artistEmail: artwork.artistEmail,
                    buyerEmail,
                    price: artwork.price,
                    transactionId: session.payment_intent,
                    type: "purchase",
                    paymentStatus: "paid",
                    purchasedAt: new Date(),
                });

                const updateResult = await artCollection.updateOne(
                    {
                        _id: new ObjectId(artworkId),
                    },
                    {
                        $set: {
                            availability: "Sold",
                        },
                    }
                );

                console.log(updateResult);
            }

            res.send({
                success: true,
                artworkId,
            });
        });


        app.get("/purchase-history/:email", async (req, res) => {
            try {
                const email = req.params.email;

                const purchases = await purchasesCollection
                    .find({
                        buyerEmail: email,
                        paymentStatus: "paid",
                    })
                    .sort({ purchasedAt: -1 })
                    .toArray();

                const purchaseHistory = await Promise.all(
                    purchases.map(async (purchase) => {
                        const artwork = await artCollection.findOne({
                            _id: new ObjectId(purchase.artworkId),
                        });

                        return {
                            _id: purchase._id,
                            artworkName: artwork?.title,
                            artworkId: artwork._id.toString(),
                            artist: artwork?.artistName,
                            price: artwork?.price,
                            image: artwork?.image,
                            purchaseDate: purchase.purchasedAt,
                        };
                    })
                );

                res.json(purchaseHistory);

            } catch (err) {
                console.error(err);
                res.status(500).json({
                    message: err.message,
                });
            }
        });

        app.patch("/user/update-profile", async (req, res) => {
            try {
                const { name, email, image } = req.body;

                const result = await usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            name,
                            image,
                        },
                    }
                );

                res.json(result);
            } catch (err) {
                console.log(err);
                res.status(500).json({ message: "Profile update failed" });
            }
        });

        app.get("/artist-dashboard/:email", async (req, res) => {
            try {
                const email = req.params.email;

                const artworks = await artCollection
                    .find({ artistEmail: email })
                    .sort({ createdAt: -1 })
                    .toArray();

                const totalArtworks = artworks.length;

                const activeListings = artworks.filter(
                    art => art.availability === "Available"
                ).length;

                const artworkIds = artworks.map(art => art._id.toString());

                const purchases = await purchasesCollection
                    .find({
                        artworkId: { $in: artworkIds }
                    })
                    .sort({ purchasedAt: -1 })
                    .toArray();

                const totalSales = purchases.length;

                const revenue = purchases.reduce((sum, purchase) => {
                    const artwork = artworks.find(
                        art => art._id.toString() === purchase.artworkId
                    );

                    return sum + (artwork?.price || 0);
                }, 0);

                const recentSales = purchases.map(purchase => {
                    const artwork = artworks.find(
                        art => art._id.toString() === purchase.artworkId
                    );

                    return {
                        _id: purchase._id,
                        artwork: artwork?.title,
                        buyer: purchase.buyerEmail,
                        amount: artwork?.price,
                        date: purchase.purchasedAt,
                    };
                });

                res.send({
                    totalArtworks,
                    activeListings,
                    totalSales,
                    revenue,
                    recentArtworks: artworks.slice(0, 5),
                    recentSales: recentSales.slice(0, 5),
                });
            } catch (err) {
                console.log(err);
                res.status(500).send({
                    message: "Failed to load dashboard",
                });
            }
        });

        app.get("/admin/dashboard-stats", async (req, res) => {
            try {

                const totalUsers = await usersCollection.countDocuments();

                const totalArtists = await usersCollection.countDocuments({
                    role: "artist",
                });

                const totalSold = await artCollection.countDocuments({
                    availability: "Sold",
                });

                const purchases = await purchasesCollection.find().toArray();

                const revenue = purchases.reduce(
                    (sum, item) => sum + Number(item.price || 0),
                    0
                );

                res.send({
                    totalUsers,
                    totalArtists,
                    totalSold,
                    revenue,
                });

            } catch (err) {
                console.log(err);
                res.status(500).send({
                    message: "Failed to load dashboard stats",
                });
            }
        });

        app.get("/admin/recent-artworks", async (req, res) => {

            const artworks = await artCollection
                .find()
                .sort({ createdAt: -1 })
                .limit(5)
                .toArray();

            res.send(artworks);

        });

        app.get("/admin/recent-transactions", async (req, res) => {

            const purchases = await purchasesCollection
                .find()
                .sort({ purchasedAt: -1 })
                .limit(5)
                .toArray();

            res.send(purchases);

        });


        app.get("/admin/sales-chart", async (req, res) => {

            const purchases = await purchasesCollection.find().toArray();

            const monthly = {};

            purchases.forEach(item => {

                const month = new Date(item.purchasedAt).toLocaleString("default", {
                    month: "short",
                });

                monthly[month] = (monthly[month] || 0) + Number(item.price || 0);

            });

            const result = Object.entries(monthly).map(([month, revenue]) => ({
                month,
                revenue,
            }));

            res.send(result);

        });

        app.get("/admin/category-chart", async (req, res) => {

            const result = await artCollection.aggregate([
                {
                    $group: {
                        _id: "$category",
                        value: {
                            $sum: 1,
                        },
                    },
                },
            ]).toArray();

            const formatted = result.map(item => ({
                name: item._id,
                value: item.value,
            }));

            res.send(formatted);

        });

        app.get("/admin/users", async (req, res) => {

            const users = await usersCollection.find().toArray();

            res.send(users);

        });

        app.patch("/admin/users/:id", async (req, res) => {

            const { role } = req.body;

            const result = await usersCollection.updateOne(
                {
                    _id: new ObjectId(req.params.id),
                },
                {
                    $set: {
                        role,
                    },
                }
            );

            res.send(result);

        });

        app.get("/admin/artworks", async (req, res) => {

            const artworks = await artCollection.find().toArray();

            res.send(artworks);

        });

        app.delete("/admin/artworks/:id", async (req, res) => {

            const result = await artCollection.deleteOne({
                _id: new ObjectId(req.params.id),
            });

            res.send(result);

        });

        app.get("/admin/transactions", async (req, res) => {

            const transactions = await purchasesCollection
                .find()
                .sort({ purchasedAt: -1 })
                .toArray();

            res.send(transactions);

        });

        app.get("/user", async (req, res) => {
            const users = await usersCollection
                .find()
                .toArray();

            res.send(users);
        });




        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!")
    } catch (error) {
        console.error("MongoDB connection error:", error);
    }
}
run().catch(console.dir)

app.get('/', (req, res) => {
    res.send("Server is running fine!")
})

app.listen(PORT, () => {
    console.log(`Server is running on ${PORT}`)
})
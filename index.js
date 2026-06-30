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
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");


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


const JWKS = createRemoteJWKSet(
    new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
);
const verifyToken = async (req, res, next) => {
    const authHeader = req?.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ message: "Unauthorized" });
    }
    const token = authHeader.split(" ")[1];
    if (!token) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    try {
        const { payload } = await jwtVerify(token, JWKS);
        req.user = payload;
        console.log(payload);
        next();
    } catch (error) {
        return res.status(403).json({ message: "Forbidden" });
    }
};



async function run() {
    try {
        await client.connect();
        const db = client.db("arthub");
        const artCollection = db.collection("artworks")
        const usersCollection = db.collection("user");
        const purchasesCollection = db.collection("purchases");
        const transactionsCollection = db.collection("transactions");

        app.post("/artworks", verifyToken, async (req, res) => {
            const artData = req.body;
            const result = await artCollection.insertOne(artData);
            res.json(result)
        })


        app.get("/artworks", async (req, res) => {

            const result = await artCollection.find({
                status: "Approved"
            }).toArray();

            res.send(result);
        });


        app.get("/artworks/artist", verifyToken, async (req, res) => {
            try {
                // ✅ prevent crash
                if (!req.user || !req.user.email) {
                    return res.status(401).json({
                        message: "Unauthorized - invalid token payload"
                    });
                }

                const email = req.user.email;

                const result = await artCollection
                    .find({ artistEmail: email })
                    .sort({ createdAt: -1 })
                    .toArray();

                return res.json(result);

            } catch (err) {
                console.error("🔥 Backend error:", err);

                return res.status(500).json({
                    message: "Internal server error"
                });
            }
        });
        app.get("/artworks/:id", async (req, res) => {

            const artwork = await artCollection.findOne({
                _id: new ObjectId(req.params.id)
            });

            if (!artwork) {
                return res.status(404).send({
                    message: "Artwork not found"
                });
            }

            if (artwork.status !== "Approved") {
                return res.status(403).send({
                    message: "Artwork is awaiting approval."
                });
            }

            res.send(artwork);

        });

        app.delete("/artworks/:id", verifyToken, async (req, res) => {
            const id = req.params.id;

            const result = await artCollection.deleteOne({
                _id: new ObjectId(id),
            });

            res.send(result);
        });



        app.put("/artworks/:id", verifyToken, async (req, res) => {
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



        app.get("/user/:email", verifyToken, async (req, res) => {
            try {
                const email = req.user.email;

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
            "/user/subscription/:email", verifyToken,
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

        app.post("/create-checkout-session", verifyToken, async (req, res) => {
            try {
                const { artworkId, buyerEmail } = req.body;


                const user = await usersCollection.findOne({
                    email: buyerEmail,
                });

                if (!user) {
                    return res.status(404).json({
                        message: "User not found",
                    });
                }


                const artwork = await artCollection.findOne({
                    _id: new ObjectId(artworkId),
                });

                if (!artwork) {
                    return res.status(404).json({
                        message: "Artwork not found",
                    });
                }

                if (artwork.artistEmail === buyerEmail) {
                    return res.status(400).json({
                        message: "You cannot purchase your own artwork.",
                    });
                }

                if (artwork.availability === "Sold") {
                    return res.status(400).json({
                        message: "This artwork has already been sold.",
                    });
                }

                const tier = (user.subscriptionTier || "free").toLowerCase();

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



        app.post("/verify-payment", verifyToken, async (req, res) => {
            try {
                console.log("VERIFY PAYMENT HIT");


                const { sessionId } = req.body;

                if (!sessionId) {
                    return res.status(400).json({
                        message: "Session ID is required",
                    });
                }

                const session = await stripe.checkout.sessions.retrieve(sessionId);

                if (session.payment_status !== "paid") {
                    return res.status(400).json({
                        message: "Payment not completed",
                    });
                }

                const artworkId = session.metadata.artworkId;
                const buyerEmail = session.metadata.buyerEmail;

                const user = await usersCollection.findOne({
                    email: buyerEmail,
                });

                const artwork = await artCollection.findOne({
                    _id: new ObjectId(artworkId),
                });

                if (!artwork) {
                    return res.status(404).send({
                        message: "Artwork not found",
                    });
                }

                const alreadyPurchased = await purchasesCollection.findOne({
                    artworkId,
                    buyerEmail,
                });
                if (alreadyPurchased) {
                    return res.send({
                        success: true,
                        artworkId,
                        transactionId: session.payment_intent,
                    });
                }

                const latestArtwork = await artCollection.findOne({
                    _id: new ObjectId(artworkId),
                });

                if (!latestArtwork) {
                    return res.status(404).send({
                        message: "Artwork not found",
                    });
                }

                if (latestArtwork.availability === "Sold") {
                    return res.status(400).send({
                        message: "Artwork already sold.",
                    });
                }

                if (!alreadyPurchased) {

                    await purchasesCollection.insertOne({
                        artworkId,

                        artworkName: artwork.title,

                        image: artwork.image,

                        category: artwork.category,

                        artist: artwork.artistName,

                        artistEmail: artwork.artistEmail,

                        buyerEmail,

                        price: artwork.price,

                        transactionId: session.payment_intent,

                        paymentMethod: "Stripe",

                        subscriptionTier: user.subscriptionTier,

                        type: "purchase",

                        paymentStatus: session.payment_status,

                        purchaseDate: new Date(session.created * 1000),
                    });

                    await transactionsCollection.insertOne({
                        transactionId: session.payment_intent,

                        sessionId: session.id,

                        paymentMethod: "Stripe",

                        type: "purchase",

                        artworkId,

                        artworkTitle: artwork.title,

                        buyerEmail,

                        artistEmail: artwork.artistEmail,

                        amount: session.amount_total / 100,

                        currency: session.currency,

                        paymentStatus: session.payment_status,

                        createdAt: new Date(session.created * 1000),
                    });
                    await artCollection.updateOne(
                        {
                            _id: new ObjectId(artworkId),
                        },
                        {
                            $set: {
                                availability: "Sold",
                            },
                        }
                    );
                }

                res.send({
                    success: true,
                    artworkId,
                    transactionId: session.payment_intent,
                });

            } catch (error) {
                console.error("VERIFY PAYMENT ERROR:", error);

                res.status(500).json({
                    success: false,
                    message: error.message,
                    stack: error.stack,
                });
            }
        });


        app.get("/purchase-history/:email", verifyToken, async (req, res) => {
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
                            purchaseDate: purchase.purchaseDate,
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

        app.get("/dashboard/user/:email", verifyToken, async (req, res) => {
            try {
                const { email } = req.params;

                const user = await usersCollection.findOne({
                    email,
                });

                if (!user) {
                    return res.status(404).json({
                        message: "User not found",
                    });
                }

                const purchases = await purchasesCollection
                    .find({
                        buyerEmail: email,
                        paymentStatus: "paid",
                    })
                    .sort({ purchaseDate: -1 })
                    .toArray();

                const totalPurchased = purchases.length;

                const totalSpent = purchases.reduce(
                    (sum, item) => sum + Number(item.price || 0),
                    0
                );

                const recentPurchases = purchases.slice(0, 5);

                res.json({
                    totalPurchased,
                    totalTransactions: totalPurchased,
                    totalSpent,
                    subscriptionTier: user.subscriptionTier || "Free",
                    recentPurchases,
                });
            } catch (error) {
                console.error(error);

                res.status(500).json({
                    message: error.message,
                });
            }
        });

        app.patch("/user/update-profile", verifyToken, async (req, res) => {
            try {
                const { name, image } = req.body;
                const email = req.user.email;

                const user = await usersCollection.findOne({ email });

                if (!user) {
                    return res.status(404).json({ message: "User not found" });
                }

                await usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            name,
                            image,
                        },
                    }
                );

                const artworkResult = await artCollection.updateMany(
                    { artistEmail: email },
                    {
                        $set: {
                            artistName: name,
                        },
                    }
                );

                console.log({
                    matched: artworkResult.matchedCount,
                    modified: artworkResult.modifiedCount,
                });


                res.json({
                    success: true,
                    message: "Profile updated successfully",
                });

            } catch (err) {
                console.error(err);
                res.status(500).json({ message: "Profile update failed" });
            }
        });

        app.get("/artist-dashboard/:email", verifyToken, async (req, res) => {
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
        app.get("/artist/sales", verifyToken, async (req, res) => {
            try {
                const email = req.user.email;

                const sales = await transactionsCollection
                    .find({
                        artistEmail: email,
                        type: "purchase",
                    })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(sales);
            } catch (err) {
                res.status(500).send({
                    message: err.message,
                });
            }
        });
        app.get("/admin/dashboard-stats", verifyToken, async (req, res) => {
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

        app.get("/admin/recent-artworks", verifyToken, async (req, res) => {

            const artworks = await artCollection
                .find()
                .sort({ createdAt: -1 })
                .limit(5)
                .toArray();

            res.send(artworks);

        });

        app.get("/admin/recent-transactions", verifyToken, async (req, res) => {

            const purchases = await purchasesCollection
                .find()
                .sort({ purchasedAt: -1 })
                .limit(5)
                .toArray();

            res.send(purchases);

        });


        // app.get("/admin/sales-chart", async (req, res) => {

        //     const purchases = await purchasesCollection.find().toArray();

        //     const monthly = {};

        //     purchases.forEach(item => {

        //         const month = new Date(item.purchasedAt).toLocaleString("default", {
        //             month: "short",
        //         });

        //         monthly[month] = (monthly[month] || 0) + Number(item.price || 0);

        //     });

        //     const result = Object.entries(monthly).map(([month, revenue]) => ({
        //         month,
        //         revenue,
        //     }));

        //     res.send(result);

        // });

        // app.get("/admin/category-chart", async (req, res) => {

        //     const result = await artCollection.aggregate([
        //         {
        //             $group: {
        //                 _id: "$category",
        //                 value: {
        //                     $sum: 1,
        //                 },
        //             },
        //         },
        //     ]).toArray();

        //     const formatted = result.map(item => ({
        //         name: item._id,
        //         value: item.value,
        //     }));

        //     res.send(formatted);

        // });

        // app.get("/admin/users", async (req, res) => {

        //     const users = await usersCollection.find().toArray();

        //     res.send(users);

        // });

        app.get("/admin/dashboard", verifyToken, async (req, res) => {
            try {



                const totalUsers = await usersCollection.countDocuments({
                    role: "user",
                });

                const totalArtists = await usersCollection.countDocuments({
                    role: "artist",
                });

                const artworksSold = await purchasesCollection.countDocuments({
                    paymentStatus: "paid",
                });

                const revenueResult = await transactionsCollection.aggregate([
                    {
                        $match: {
                            type: "purchase",
                            paymentStatus: "paid",
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            totalRevenue: {
                                $sum: "$amount",
                            },
                        },
                    },
                ]).toArray();

                const totalRevenue =
                    revenueResult.length > 0
                        ? revenueResult[0].totalRevenue
                        : 0;



                const salesChart = await transactionsCollection.aggregate([
                    {
                        $match: {
                            type: "purchase",
                            paymentStatus: "paid",
                        },
                    },
                    {
                        $group: {
                            _id: {
                                month: {
                                    $month: "$createdAt",
                                },
                            },
                            total: {
                                $sum: "$amount",
                            },
                        },
                    },
                    {
                        $sort: {
                            "_id.month": 1,
                        },
                    },
                ]).toArray();


                const categoryChart = await artCollection.aggregate([
                    {
                        $group: {
                            _id: "$category",
                            count: {
                                $sum: 1,
                            },
                        },
                    },
                    {
                        $sort: {
                            count: -1,
                        },
                    },
                ]).toArray();


                const recentArtworks = await artCollection
                    .find()
                    .sort({
                        createdAt: -1,
                    })
                    .limit(5)
                    .toArray();



                const recentTransactions = await transactionsCollection
                    .find({
                        type: "purchase",
                    })
                    .sort({
                        createdAt: -1,
                    })
                    .limit(5)
                    .toArray();

                res.send({
                    stats: {
                        totalUsers,
                        totalArtists,
                        artworksSold,
                        totalRevenue,
                    },

                    salesChart,

                    categoryChart,

                    recentArtworks,

                    recentTransactions,
                });

            } catch (err) {
                console.log(err);

                res.status(500).send({
                    message: err.message,
                });
            }
        });

        app.patch("/admin/users/:id", verifyToken, async (req, res) => {

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

        app.get("/admin/artworks", verifyToken, async (req, res) => {

            const artworks = await artCollection.find().toArray();

            res.send(artworks);

        });

        app.delete("/admin/artworks/:id", verifyToken, async (req, res) => {

            const result = await artCollection.deleteOne({
                _id: new ObjectId(req.params.id),
            });

            res.send(result);

        });

        app.get("/admin/transactions", verifyToken, async (req, res) => {

            const transactions = await purchasesCollection
                .find()
                .sort({ purchasedAt: -1 })
                .toArray();

            res.send(transactions);

        });

        app.get("/user", verifyToken, async (req, res) => {
            const users = await usersCollection
                .find()
                .toArray();

            res.send(users);
        });
        app.get("/users/:email", async (req, res) => {
            const email = req.params.email;

            const user = await usersCollection.findOne(
                { email },
                {
                    projection: {
                        name: 1,
                        image: 1,
                        email: 1,
                    },
                }
            );

            if (!user) {
                return res.status(404).send({ message: "User not found" });
            }

            res.send(user);
        });
        app.patch("/user/role/:email", verifyToken, async (req, res) => {
            const email = req.params.email;
            const { role } = req.body;

            const result = await usersCollection.updateOne(
                { email },
                {
                    $set: {
                        role,
                    },
                }
            );

            res.send(result);
        });

        app.get("/admin/artworks", verifyToken, async (req, res) => {
            const result = await artCollection
                .find()
                .sort({ createdAt: -1 })
                .toArray();

            res.send(result);
        });

        app.patch("/admin/artworks/approve/:id", verifyToken, async (req, res) => {

            const result = await artCollection.updateOne(
                {
                    _id: new ObjectId(req.params.id)
                },
                {
                    $set: {
                        status: "Approved"
                    }
                }
            );

            res.send(result);

        });
        app.patch("/admin/artworks/reject/:id", verifyToken, async (req, res) => {

            const result = await artCollection.updateOne(
                {
                    _id: new ObjectId(req.params.id)
                },
                {
                    $set: {
                        status: "Rejected"
                    }
                }
            );

            res.send(result);

        });

        app.get("/artist/:email", async (req, res) => {
            try {
                const email = req.params.email;

                const artist = await usersCollection.findOne({
                    email,
                });

                if (!artist) {
                    return res.status(404).send({
                        message: "Artist not found",
                    });
                }

                const artworks = await artCollection
                    .find({
                        artistEmail: email,
                    })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send({
                    artist,
                    artworks,
                });

            } catch (err) {
                res.status(500).send({
                    message: err.message,
                });
            }
        });
        app.get("/transactions", verifyToken, async (req, res) => {
            try {

                const transactions = await transactionsCollection
                    .find()
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(transactions);

            } catch (err) {

                res.status(500).send({
                    message: err.message,
                });

            }
        });
        app.get("/top-artists", async (req, res) => {
            try {

                const topArtists = await purchasesCollection.aggregate([
                    {
                        $group: {
                            _id: "$artistEmail",
                            totalSales: { $sum: 1 },
                            name: { $first: "$artist" }
                        }
                    },
                    {
                        $sort: {
                            totalSales: -1
                        }
                    },
                    {
                        $limit: 3
                    },
                    {
                        $lookup: {
                            from: "users",
                            localField: "_id",
                            foreignField: "email",
                            as: "user"
                        }
                    },
                    {
                        $unwind: {
                            path: "$user",
                            preserveNullAndEmptyArrays: true
                        }
                    },
                    {
                        $project: {
                            _id: 0,
                            email: "$_id",
                            name: 1,
                            image: "$user.image",
                            totalSales: 1
                        }
                    }
                ]).toArray();

                res.send(topArtists);

                const artist = await usersCollection.findOne({
                    email: grouped[0]._id
                });
                console.log(artist);

            } catch (err) {
                res.status(500).send({
                    message: err.message
                });
            }
        });

        app.get("/artworks", async (req, res) => {
            const { category } = req.query;

            const query = {};

            if (category) {
                query.category = category;
            }

            const artworks = await artCollection.find(query).toArray();

            res.send(artworks);
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
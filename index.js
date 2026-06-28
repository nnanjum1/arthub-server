const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require('express');
const cors = require('cors')

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const dotenv = require('dotenv');
dotenv.config()

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
        const usersCollection = db.collection("users");

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


        app.get("/users/:email", async (req, res) => {
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

        app.patch("/users/subscription/:email", async (req, res) => {
            try {
                const email = req.params.email;
                const { subscriptionTier } = req.body;

                const result = await usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            subscriptionTier,
                        },
                    }
                );

                res.json(result);
            } catch (error) {
                console.error(error);

                res.status(500).json({
                    message: "Failed to update subscription",
                });
            }
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
/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const storeProducts = require("./src/store_products");
const searchProducts = require("./src/search_products");

// const test = require("./sample.ts").default;


// The Firebase Admin SDK to access firestore.
// const admin = require("firebase-admin");

const {getFirestore, Timestamp, FieldValue} = require('firebase-admin/firestore');


// initializeApp();

const db = getFirestore();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());


app.get('/', (req, res) => {
    res.send({message: "Hello World!"});
});


app.get('/sampleProducts', async (req, res) => {
    try {
        const db = getFirestore();
        const productsRef = db.collection('mylist');
        // const querySnapshot = await productsRef.where('price', '<', 60).get();
        const querySnapshot = await productsRef.get();

        const products = [];
        querySnapshot.forEach((doc) => {
            products.push(doc.data());
        });

        res.json(products);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.post('/fetchStoreProducts', storeProducts.storeProducts);
app.post('/searchProducts', searchProducts.searchProducts);


app.post('/storeRanking', async (req, res) => {
    if (!req.body.hasOwnProperty('store_ids') && !req.body.hasOwnProperty('list_id')) {
        return res.status(400).json({error: "store_id and list_id field is required."});
    }

    if (req.body.store_ids.length <= 0) {
        return res.status(400).json({error: "store_ids should not be empty."});
    }


    const missingProductMap = new Map();
    const similarProductMap = new Map();
    const productInListMap = new Map();


    try {
        const nearbyStoresIds = req.body.store_ids;
        const listId = req.body.list_id;
        const isPreloadedList = req.body.is_preloaded_list;

        const nearbyStoreRefs = nearbyStoresIds.map(id => db.collection('stores').doc(id));

        const [storeProductsSnapshot, productListSnapshot] = await Promise.all([
            db.collection('products_mvp')
                .where('is_exist', '==', true)
                .where('storeRef', 'in', nearbyStoreRefs)
                .get(),

            db.collection(isPreloadedList ? 'preloded_default' : 'mylist')
                .doc(listId)
                .collection(isPreloadedList ? 'preloaded_product_list' : 'user_product_list')
                .get()
        ]);

        const productRefs = productListSnapshot.docs.map(productSnapshot => productSnapshot.get('product_ref'));

        const [storeProducts, userProductsSnapshot] = await Promise.all([
            Promise.all(storeProductsSnapshot.docs.map(productSnapshot =>
                formatProductData(productSnapshot.data(), productSnapshot)
            )),

            Promise.all(productRefs.map(productRef => productRef.get()))
        ]);

        const userProducts = userProductsSnapshot.map(productSnapshot =>
            formatProductData(productSnapshot.data(), productSnapshot)
        );

        const storeTotal = new Map(nearbyStoreRefs.map(storeRef => [storeRef, 0]));
        const matchingProductCounts = new Map();

        for (const storeRef of nearbyStoreRefs) {

            for (let i = 0; i < productListSnapshot.size; i++) {
                const productSnapshot = productListSnapshot.docs[i];
                const product = userProducts[i];

                // console.log("PRODUCT",product);

                const price = parseFloat(product.minPrice);
                const quantity = productSnapshot['quantity'];
                const productId = product.productId;

                if (product.isExist && product.storeRef === storeRef.path) {
                    storeTotal.set(storeRef, (storeTotal.get(storeRef)) + (quantity * price));

                    matchingProductCounts.set(storeRef, (matchingProductCounts.get(storeRef)) + 1);


                    (productInListMap[storeRef] || []).push({'product': product, 'quantity': quantity});

                    continue;
                }

                const productInStore = await getSimilarProductFromList({
                    storeRef: storeRef.path,
                    product: product,
                    storeProducts: storeProducts,
                    matchingProductCounts: matchingProductCounts
                });


                if (productInStore === null) {
                    if (!missingProductMap.has(storeRef)) {
                        missingProductMap.set(storeRef, []);
                    }
                    missingProductMap.get(storeRef).push({'product': product, 'quantity': quantity});
                } else if (productInStore.productId === productId) {
                    const price = parseFloat(productInStore.minPrice);

                    storeTotal.set(storeRef, (storeTotal.get(storeRef)) + (quantity * price));

                    if (!productInListMap.has(storeRef)) {
                        productInListMap.set(storeRef, []);
                    }
                    productInListMap.get(storeRef).push({'product': productInStore, 'quantity': quantity});
                } else {
                    const price = parseFloat(productInStore.minPrice);

                    storeTotal.set(storeRef, (storeTotal.get(storeRef)) + (quantity * price));

                    if (!similarProductMap.has(storeRef)) {
                        similarProductMap.set(storeRef, []);
                    }
                    similarProductMap.get(storeRef).push({'product': productInStore, 'quantity': quantity});
                }
            }
        }

        const stores = [];
        for (const [storeRef, totalPrice] of storeTotal.entries()) {
            const matchingProductCount = matchingProductCounts.get(storeRef) || 0;
            const matchingPercentage = (matchingProductCount / productListSnapshot.size) * 100;

            const store = await getStoreFromPath({
                path: storeRef,
                totalPrice: totalPrice,
                matchingPercentage: matchingPercentage
            });
            stores.push(store);
        }

        console.log("storeTotal", JSON.stringify(Object.entries(storeTotal)));

        stores.sort((a, b) => {
            const result = b.matchingPercentage - a.matchingPercentage;
            /* if (result === 0) {
                return a.distance.localeCompare(b.distance); // Sort by distance when matchingPercentage is the same
            } */
            return result;
        });


        res.json({
            "stores": stores,
            "matching": productInListMap,
            "similar": similarProductMap,
            "missing": missingProductMap
        });

    } catch (error) {
        console.error("Error fetching products:", error);
        res.status(500).json({error: "An error occurred while fetching products."});
    }
});

async function getStoreFromPath({path, totalPrice, matchingPercentage}) {
    const storeSnapshot = await path.get();
    const location = storeSnapshot['location']; // Assuming location is a GeoPoint object in Firestore

    /* const distance = await getDistanceFromLocation({
        userLocation: { latitude: 20.68016662, longitude: -103.3822084 }, // Replace with actual user location
        destinationLocation: location
    }); */

    // console.log("storeSnapshot",JSON.stringify(storeSnapshot.data()));

    return {
        storeRef: path,
        logo: storeSnapshot['logo'],
        name: storeSnapshot['name'],
        totalPrice: totalPrice,
        matchingPercentage: Math.floor(matchingPercentage),
        distance: 5,
        location: location,
        address: storeSnapshot['adress'] // Fix typo to 'address' if it's changed in the database
    };
}


async function getSimilarProductFromList({
                                             product,
                                             storeProducts,
                                             storeRef,
                                             matchingProductCounts
                                         }) {
    const productId = product.productId;
    const genericNames = [...product.genericNames];
    const measure = product.measure;
    const department = product.department;
    const actualStoreRef = db.doc(storeRef);

    // console.log('Searching for similar product:');
    // console.log('Product ID:', productId);
    // console.log('Generic Names:', genericNames);
    // console.log('Measure:', measure);
    // console.log('Department:', department);

    const exactProduct = storeProducts.find(
        element =>
            element.storeRef === storeRef &&
            element.productId === productId &&
            element.isExist
    );

    if (exactProduct !== undefined) {
        // console.log('Found exact product match:');
        // console.log('Product ID:', productId);
        matchingProductCounts[actualStoreRef] =
            (matchingProductCounts[actualStoreRef] || 0) + 1;
        return exactProduct;
    }

    let bestMatch = null;
    let bestMatchPrice = null;
    let bestMatchPercentage = 0;

    for (const similarProduct of storeProducts) {
        const similarGenericNames = similarProduct.genericNames;
        const similarMeasure = similarProduct.measure;
        const similarDepartment = similarProduct.department;

        if (
            similarProduct.storeRef === storeRef &&
            similarMeasure === measure &&
            similarDepartment === department
        ) {
            const similarPrice = parseFloat(similarProduct.minPrice);
            const relationPercentage = calculateRelation(
                genericNames,
                similarGenericNames
            );

            if (
                !isNaN(similarPrice) &&
                (bestMatch === null ||
                    bestMatchPrice === null ||
                    relationPercentage > bestMatchPercentage ||
                    (relationPercentage === bestMatchPercentage &&
                        similarPrice < bestMatchPrice))
            ) {
                bestMatch = similarProduct;
                bestMatchPrice = similarPrice;
                bestMatchPercentage = relationPercentage;
            }
        }
    }

    if (bestMatchPercentage <= 0.65) {
        // console.log(`Similar product found BUT with ${bestMatchPercentage * 100}%:`);
        return null;
    }
    matchingProductCounts[actualStoreRef] =
        (matchingProductCounts[actualStoreRef] || 0) + bestMatchPercentage;

    /* if (bestMatch !== null) {
        console.log('Found similar product:');
        console.log('Product ID:', bestMatch.productId);
        console.log('Generic Names:', bestMatch.genericNames);
        console.log('Price:', bestMatch.minPrice);
    } else {
        console.log('No similar product found.');
    } */

    return bestMatch;
}

function calculateRelation(mainGenericNames, otherGenericNames) {
    const otherGenericNamesSet = new Set(otherGenericNames);

    const matches = mainGenericNames.filter(item =>
        otherGenericNamesSet.has(item)
    ).length;
    const mainLength = mainGenericNames.length;
    const otherLength = otherGenericNames.length;

    const relationPercentage = matches / Math.max(mainLength, otherLength);

    return Number(relationPercentage.toFixed(2));
}

const formatProductData = (data, productSnapshot) => {
    return {
        productId: data.product_id.toString(),
        productRef: productSnapshot.ref.id.toString(),
        isExist: data.is_exist,
        department: data.department_name.toString(),
        measure: data.measure.toString(),
        name: data.name.toString(),
        pImage: data.pImage.toString(),
        storeRef: data.storeRef.path.toString(),
        genericNames: data.genericNames,
        minPrice: data.price.toString(),
        maxPrice: '',
    };
};


// const port = 3000;
//
// app.listen(port, () => {
//     console.log(`Example app listening on port ${port}`);
// });


exports.api = onRequest(app);
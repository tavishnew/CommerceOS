import { v4 as uuidv4 } from 'uuid';
import { A2AClient, A2ACardResolver, Role } from "a2a-js";

/**
 * Agent 1: Customer-Facing Agent
 * 
 * This agent has NO tools and serves as a customer interface.
 * It requests product inventory information from Agent 2 via A2A Protocol.
 * 
 * A2A Protocol Flow:
 * 1. Discovers Agent 2 via /.well-known/agent.json
 * 2. Sends task using tasks/send (JSON-RPC 2.0)
 * 3. Receives task response with artifacts containing product data
 * 4. Extracts and displays product information to customer
 */

// Configuration
const AGENT_B_URL = "http://localhost:3001"; // Agent 2 (Product Service)
const SESSION_ID = 'product-inquiry-session';

/**
 * Extract text from A2A message parts
 */
function extractMessageText(message) {
  if (!message || !message.parts) return '';
  return message.parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');
}

/**
 * Extract structured data from A2A message parts
 * Looks for DataPart (type: 'data') which contains JSON data
 */
function extractDataFromMessage(message) {
  if (!message || !message.parts) return null;
  
  const dataPart = message.parts.find(part => part.type === 'data');
  return dataPart ? dataPart.data : null;
}

/**
 * Extract artifacts from task response
 * Artifacts contain structured outputs from Agent 2 (like product inventory)
 */
function extractArtifacts(task) {
  if (!task || !task.artifacts || !Array.isArray(task.artifacts)) {
    return [];
  }
  
  return task.artifacts.map(artifact => {
    // Extract data from artifact parts
    const dataParts = artifact.parts.filter(part => part.type === 'data');
    return {
      name: artifact.name,
      description: artifact.description,
      data: dataParts.map(part => part.data)
    };
  });
}

/**
 * Format product data for display
 * Handles normalized product format from Agent 2
 */
function formatProductsForDisplay(products) {
  if (!products || !Array.isArray(products)) {
    return "No products found";
  }
  
  return products.map((product, index) => {
    const priceStr = product.currency 
      ? `${product.currency} ${product.price}` 
      : `$${product.price || 'N/A'}`;
    
    const stockStatus = product.inStock 
      ? `✅ In Stock (${product.quantity} available)` 
      : '❌ Out of Stock';
    
    return `\n${index + 1}. ${product.name || 'Unnamed Product'}\n   SKU: ${product.sku || 'N/A'}\n   Price: ${priceStr}\n   Status: ${stockStatus}\n   ${product.category ? `Category: ${product.category}` : ''}\n   ${product.vendor ? `Vendor: ${product.vendor}` : ''}`;
  }).join('\n');
}

/**
 * Main function: Request products from Agent 2
 */
async function requestProducts() {
  console.log("🛒 Agent 1: Customer-Facing Agent");
  console.log("=" .repeat(60));
  console.log("📋 Purpose: Request product inventory from Agent 2");
  console.log("🔧 Tools: None (customer-facing only)");
  console.log();
  
  try {
    console.log("📡 Step 1: Discovering Agent 2 (A2A Protocol)");
    console.log(`   GET ${AGENT_B_URL}/.well-known/agent.json`);
    
    const resolver = new A2ACardResolver(AGENT_B_URL);
    const agentCard = await resolver.getAgentCard();
    
    console.log("✅ Agent 2 Discovered:");
    console.log(`   Name: ${agentCard.name}`);
    console.log(`   Description: ${agentCard.description}`);
    if (agentCard.skills && agentCard.skills.length > 0) {
      console.log(`   Available Skills: ${agentCard.skills.map(s => s.name).join(', ')}`);
    }
    console.log();
    
    console.log("📡 Step 2: Creating A2A Client");
    console.log("   The client will handle JSON-RPC 2.0 protocol");
    
    const client = new A2AClient(AGENT_B_URL, fetch);
    console.log("✅ A2A Client initialized");
    console.log();
    
    console.log("📤 Step 3: Sending Product Request (A2A Protocol)");
    console.log("   Method: tasks/send (JSON-RPC 2.0)");
    console.log("   Request: Get all products from inventory");
    
    const taskId = uuidv4();
    
    const task = await client.sendTask({
      id: taskId,
      sessionId: SESSION_ID,
      message: {
        role: Role.User,  // Agent 1 is the user/client in this transaction
        parts: [
          {
            type: 'text',
            text: 'Get all products from inventory'
          }
        ]
      }
    });
    
    if (!task) {
      console.error("❌ Failed to receive task response");
      return;
    }
    
    console.log("✅ Task Response Received");
    console.log(`   Task ID: ${task.id}`);
    console.log(`   Task State: ${task.status?.state}`);
    console.log();
    
    // Step 4: Extract product data from response
    // Agent 2 should return products in artifacts (structured outputs)
    console.log("📥 Step 4: Extracting Product Data");
    
    const artifacts = extractArtifacts(task);
    
    if (artifacts.length > 0) {
      console.log(`✅ Found ${artifacts.length} artifact(s)`);
      
      // Extract product data from artifacts
      for (const artifact of artifacts) {
        console.log(`   Artifact: ${artifact.name || 'Unnamed'}`);
        if (artifact.description) {
          console.log(`   Description: ${artifact.description}`);
        }
        
        // Artifact data contains the actual product inventory
        for (const data of artifact.data) {
          if (data.products && Array.isArray(data.products)) {
            // Display shop metadata if available
            if (data.metadata) {
              console.log(`\n🏪 Shop: ${data.metadata.shop || 'Unknown'}`);
              console.log(`   Currency: ${data.metadata.currency || 'USD'}`);
              console.log(`   Total Products: ${data.metadata.total || data.products.length}`);
              if (data.metadata.lastSync) {
                console.log(`   Last Sync: ${data.metadata.lastSync}`);
              }
            }
            
            console.log(`\n📦 Products Received: ${data.products.length} items`);
            console.log(formatProductsForDisplay(data.products));
          } else if (data) {
            console.log("   Data:", JSON.stringify(data, null, 2));
          }
        }
      }
    } else {
      // Fallback: Check message for text response
      const responseMessage = task.status?.message;
      if (responseMessage) {
        const responseText = extractMessageText(responseMessage);
        console.log("📝 Response Message:");
        console.log(responseText);
        
        const messageData = extractDataFromMessage(responseMessage);
        if (messageData && messageData.products) {
          console.log("\n📦 Products in Message:");
          console.log(formatProductsForDisplay(messageData.products));
        }
      } else {
        console.log("⚠️  No artifacts or message found in response");
        console.log("   Full Task:", JSON.stringify(task, null, 2));
      }
    }
    
    console.log("\n" + "=".repeat(60));
    console.log("✅ A2A Transaction Complete!");
    console.log("\n📊 Summary:");
    console.log("  ✓ Agent discovery via /.well-known/agent.json");
    console.log("  ✓ Product request sent via tasks/send");
    console.log("  ✓ Product data received via artifacts");
    console.log("  ✓ All communication via A2A Protocol (JSON-RPC 2.0)");
    console.log();
    
  } catch (error) {
    console.error("\n❌ Error in A2A transaction:", error.message);
    console.error(error);
    process.exit(1);
  }
}

// Run the product request
requestProducts().catch(error => {
  console.error("\n❌ Fatal error:", error);
  process.exit(1);
});

## M-01: The SetPoolCreator in config.rs can be bricked
The config hosts 3 major functions to the protocol, `handler_set_pool_creator()`, `handler_update_authority()` and `handler_initialize_config()`. 
The issue stems from the handler_update_authority where the flow is: 
1. Updating the program's update address to the new wallet (wallet B).
2. Then call the function to sync the config's authority from the old (wallet A) to the new (wallet B)
The `handler_set_pool_creator()` needs the wallet address signing to be both config.authority and the upgrade address for the program. If there is any mishap in the time duration from when the program upgrade account is updated and when the `handler_update_authority()` is called like loss of the old account or if it is a multi-sig, it will be rendered bricked and no pools would be able to be lauched because